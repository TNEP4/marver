import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asksOf, frameMark, isNew, nextToLook, questions, rollup, type Marks } from '../src/shared/marks.ts'
import { initMarks, markSeen, observe, projectMarks, readMarks, recordChanged, resetMarksMemory } from '../src/server/marks.ts'
import { scanFrames } from '../src/server/manifest.ts'
import type { Thread } from '../src/shared/events.ts'

const T = (id: string, frame: string, agentLast: boolean, extra: Partial<Thread> = {}): Thread => ({
  id, frame, ts: 1, resolved: false, agent: true, reactions: {},
  replies: agentLast ? [] : [{ id: `${id}-r`, ts: 2, body: 'my answer' }], ...extra,
})

describe('sidebar marks: the rules (spec 25, revisions since spec 26)', () => {
  const m: Marks = { epoch: 'e', changed: { a: 2, c: 3, d: 3 }, doc: { a: 2, c: 3, d: 3 }, seen: { c: 4 }, boards: {} }

  it('new = changed after the revision you last saw', () => {
    expect(isNew(m, 'a')).toBe(true)      // changed, never seen
    expect(isNew(m, 'b')).toBe(false)     // never changed since the marks started
    expect(isNew(m, 'c')).toBe(false)     // seen at or after its change
    expect(isNew(null, 'a')).toBe(false)  // a published canvas has no marks
  })

  it('a word asks when the agent says so; before 0.25, a note asks and a reply asks when it ends in "?"', () => {
    expect(asksOf({ body: 'Done.' }, true)).toBe(true)                        // a legacy note
    expect(asksOf({ body: 'Done - tightened.' }, false)).toBe(false)          // a legacy reply that reports
    expect(asksOf({ body: 'Which one?' }, false)).toBe(true)                  // a legacy reply that asks
    expect(asksOf({ body: 'Which one?', asks: false } as { body: string }, false)).toBe(false)   // the flag wins
    expect(asksOf({ body: 'FYI', asks: true } as { body: string }, false)).toBe(true)
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
    expect(q.get('a')).toEqual({ ask: 2, asking: 2, answered: 0 })              // notes ask
    expect(q.get('b')).toEqual({ ask: 0, asking: 0, answered: 1 })
    expect(q.has('c')).toBe(false)
    expect(q.get('d')).toEqual({ ask: 1, asking: 0, answered: 0 })              // a reply with no "?": waiting, not asking
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

  it('U: a frame that asks first, then one waiting on you, then a new one (D2)', () => {
    const q = questions([
      T('t1', 'b', true, { agent: false, replies: [{ id: 'x', ts: 3, agent: true, body: 'Done - tightened.' }] }),   // waiting, reports
      T('t2', 'c', true, { agent: false, replies: [{ id: 'y', ts: 3, agent: true, body: 'Which of the two?' }] }),   // asks
    ])
    expect(nextToLook(m, q, ['a', 'b', 'c', 'd'], null)).toBe('c')            // the asking one, though b comes first
    expect(nextToLook(m, questions([q && T('t1', 'b', true, { agent: false, replies: [{ id: 'x', ts: 3, agent: true, body: 'Done.' }] })]), ['a', 'b', 'c', 'd'], null)).toBe('b')
  })

  it('U: the next frame that needs you, else the next new one, after the current one, wrapping', () => {
    const q = questions([T('t1', 'd', true)])
    const order = ['a', 'b', 'c', 'd']
    expect(nextToLook(m, q, order, null)).toBe('d')                        // a question first
    expect(nextToLook(m, new Map(), order, 'a')).toBe('d')                  // after a: d is new
    expect(nextToLook(m, new Map(), order, 'd')).toBe('a')                  // wraps
    expect(nextToLook({ ...m, seen: { a: 9, c: 9, d: 9 } }, new Map(), order, null)).toBe(null)
    expect(nextToLook(m, questions([T('t2', 'a', false)]), order, null)).toBe('d')   // a is new but answered: U skips it
  })
})

describe('sidebar marks: the dev server (spec 26 - revisions, the clock at boot, what each frame reads)', () => {
  let root = ''
  afterEach(() => { resetMarksMemory(); if (root) { try { chmodSync(join(root, 'design', '.local'), 0o755) } catch { /* not there */ } rmSync(root, { recursive: true, force: true }) } })
  const mk = (p: string, c = 'export default () => null\n') => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c) }
  const touch = (p: string, c?: string) => { const f = join(root, p); writeFileSync(f, c ?? readFileSync(f, 'utf8') + '\n'); const t = Date.now() / 1000 + 5; utimesSync(f, t, t) }
  const frames = () => scanFrames(root).frames
  const marks = () => readMarks(root, scanFrames(root))!
  const fresh = (m: Marks) => Object.keys(m.changed).filter((id) => isNew(m, id)).sort()
  const boot = () => { resetMarksMemory(root); initMarks(root, frames()) }   // a dev server start
  const local = (f: string) => JSON.parse(readFileSync(join(root, 'design', '.local', f), 'utf8'))

  const canvas = () => {
    root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
    mk('design/scenes/s/_kit.tsx', 'export const Kit = () => null\n')
    mk('design/scenes/s/a.tsx', "import { Kit } from './_kit.tsx'\nexport default () => null\n")
    mk('design/scenes/s/b.tsx', "import { Kit } from './_kit'\nimport text from '../../../specs/s.md?raw'\nexport default () => null\n")
    mk('design/scenes/t/c.tsx')
    mk('specs/s.md', '# spec')
  }

  it('the clock starts with marver dev: the state exists before any page asks, and nothing is new', () => {
    canvas()
    boot()
    for (const f of ['changes.json', 'seen.json', 'deps.json']) expect(existsSync(join(root, 'design', '.local', f))).toBe(true)
    expect(fresh(marks())).toEqual([])
  })

  it('an agent working before anyone opens the page: an added frame (old mtime too) and an edit are new', () => {
    canvas()
    boot()
    mk('design/scenes/t/old.tsx'); utimesSync(join(root, 'design/scenes/t/old.tsx'), 1_000, 1_000)
    touch('design/scenes/t/c.tsx')
    observe(root, frames())                                                   // what the watcher does
    expect(fresh(marks())).toEqual(['t/c', 't/old'])
  })

  it('a shared file lights every frame that reads it - a kit, a spec read with ?raw - and only those', () => {
    canvas()
    boot()
    touch('design/scenes/s/_kit.tsx')
    expect(observe(root, frames()).doc.sort()).toEqual(['s/a', 's/b'])
    touch('specs/s.md')
    expect(observe(root, frames()).doc).toEqual(['s/b'])
    expect(fresh(marks())).toEqual(['s/a', 's/b'])
  })

  it('a sticky note or work done changes the frame without a new document', () => {
    canvas()
    boot()
    mk('design/scenes/s/a.note.md', 'a note')
    expect(observe(root, frames())).toEqual({ doc: [], note: ['s/a'] })
    recordChanged(root, frames(), ['t/c'], { doc: false })
    const m = marks()
    expect(fresh(m)).toEqual(['s/a', 't/c'])
    expect(m.doc['s/a'] ?? 0).toBe(0)
    expect(m.doc['t/c'] ?? 0).toBe(0)
  })

  it('app code a frame imports (an embedded app) changes it without a new document - Fast Refresh shows it', () => {
    canvas()
    mk('src/Button.tsx', 'export const Button = () => null\n')
    mk('design/scenes/t/c.tsx', "import { Button } from '../../../src/Button.tsx'\nexport default () => null\n")
    boot()
    touch('src/Button.tsx')
    expect(observe(root, frames())).toEqual({ doc: [], note: ['t/c'] })
  })

  it('seen: the revision you saw - never lowered, never past the last, refused from another epoch', () => {
    canvas()
    boot()
    touch('design/scenes/t/c.tsx'); observe(root, frames())
    const m = marks()
    expect(markSeen(root, frames(), 'not-the-epoch', { 't/c': m.changed['t/c'] })).toBe(false)
    expect(isNew(marks(), 't/c')).toBe(true)
    expect(markSeen(root, frames(), m.epoch, { 't/c': 999, 'gone/x': 1 })).toBe(true)
    expect(local('seen.json').frames).toEqual({ 't/c': m.changed['t/c'] })   // capped to the last revision; unknown ids dropped
    markSeen(root, frames(), m.epoch, { 't/c': 0 })                           // an older acknowledgement never lowers it
    expect(isNew(marks(), 't/c')).toBe(false)
    touch('design/scenes/t/c.tsx'); observe(root, frames())
    expect(isNew(marks(), 't/c')).toBe(true)                                  // a change after you looked: new again
  })

  it('dev off: a kit edited and a layout removed are new on the next start; reviewed, a plain restart keeps them clear', () => {
    canvas()
    mk('design/scenes/t/_layout.tsx', 'export default ({ children }: any) => children\n')
    boot()
    touch('design/scenes/s/_kit.tsx')
    rmSync(join(root, 'design/scenes/t/_layout.tsx'))
    boot()
    const m = marks()
    expect(fresh(m)).toEqual(['s/a', 's/b', 't/c'])
    markSeen(root, frames(), m.epoch, m.changed)
    boot()
    expect(fresh(marks())).toEqual([])
  })

  it('a frame renamed (its old mtime kept) is new; a deleted frame leaves nothing behind', () => {
    canvas()
    boot()
    rmSync(join(root, 'design/scenes/t/c.tsx'))
    mk('design/scenes/t/renamed.tsx'); utimesSync(join(root, 'design/scenes/t/renamed.tsx'), 1_000, 1_000)
    observe(root, frames())
    const m = marks()
    expect(fresh(m)).toEqual(['t/renamed'])
    expect(m.changed['t/c']).toBeUndefined()
    expect(Object.keys(local('changes.json').frames)).toEqual(['t/renamed'])
  })

  it('a 0.24 state converts once: what was new stays new (acknowledged by any look), the rest starts seen', () => {
    canvas()
    for (const p of ['design/scenes/s/a.tsx', 'design/scenes/s/b.tsx', 'design/scenes/t/c.tsx']) utimesSync(join(root, p), 500, 500)   // before the old baseline
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    writeFileSync(join(root, 'design/.local/seen.json'), JSON.stringify({ version: 1, baseline: 1_000_000, ids: ['s/a', 's/b', 't/c'], frames: { 's/b': 3_000_000 } }))
    writeFileSync(join(root, 'design/.local/changes.json'), JSON.stringify({ version: 1, frames: { 's/b': 2_500_000, 't/c': 5_000_000 } }))
    boot()
    const m = marks()
    expect(fresh(m)).toEqual(['t/c'])                                          // work done after the look; s/b was seen since
    expect(m.doc['t/c'] ?? 0).toBe(0)
    expect(local('seen.json').version).toBe(2)
  })

  it('an invalid state starts over (all seen, a new epoch); a state the disk refuses turns marks off and resets nothing', () => {
    canvas()
    boot()
    const epoch = marks().epoch
    for (const bad of ['{not json', JSON.stringify({ version: 2, epoch, rev: 1e309, frames: {} }), JSON.stringify({ version: 2, epoch, rev: 3, frames: { 's/a': 'x' } })]) {
      writeFileSync(join(root, 'design/.local/changes.json'), bad)
      boot()
      expect(marks().epoch).not.toBe(epoch)
      expect(fresh(marks())).toEqual([])
    }
    if (process.getuid?.() === 0) return                                       // root reads anything
    const before = readFileSync(join(root, 'design/.local/changes.json'), 'utf8')
    chmodSync(join(root, 'design/.local/changes.json'), 0o000)
    boot()
    expect(readMarks(root, scanFrames(root))).toBe(null)
    chmodSync(join(root, 'design/.local/changes.json'), 0o644)
    expect(readFileSync(join(root, 'design/.local/changes.json'), 'utf8')).toBe(before)
  })

  it('the read-only view (marver marks) writes nothing: null before the first start, and dev-off changes included', () => {
    canvas()
    expect(projectMarks(root, scanFrames(root))).toBe(null)
    expect(existsSync(join(root, 'design', '.local'))).toBe(false)
    boot()
    resetMarksMemory(root)                                                     // dev stopped
    const t0 = statSync(join(root, 'design/.local/changes.json')).mtimeMs
    touch('design/scenes/s/_kit.tsx')
    const p = projectMarks(root, scanFrames(root))!
    expect(fresh(p)).toEqual(['s/a', 's/b'])
    expect(statSync(join(root, 'design/.local/changes.json')).mtimeMs).toBe(t0)
  })

  it('boards roll up over their live frames; an auto board holds every frame', () => {
    canvas()
    mk('design/boards/b1.json', JSON.stringify({ version: 1, name: 'b1', nodes: [{ frame: 's/a' }, { frame: 'gone/x' }] }))
    mk('design/boards/auto.json', JSON.stringify({ version: 1, name: 'auto', auto: true, nodes: [] }))
    boot()
    const m = marks()
    expect(m.boards.b1).toEqual(['s/a'])
    expect(m.boards.auto.sort()).toEqual(['s/a', 's/b', 't/c'])
  })
})
