/**
 * The strip's live region on marks (pages/strip/needs.ts; spec 28 A4.6 #19, A2.13): "<name> needs you" on a rise, once
 * per tab per minute, never for what was found at launch or for a tab's first marks - and so never for a workspace's
 * first snapshot after main's stop, acknowledged at its new instance's ready, left the tab with none. The strip's own
 * case (pw needs-you.test.ts) runs it in the page.
 */
import { describe, expect, it } from 'vitest'
import type { TabMarks, TabView } from '../../src/shared/channels.ts'
import { needsRisen, needsSeen } from '../../pages/strip/needs.ts'

const EVERY = 60_000
const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, needs: number | null): TabView => ({
  id, kind: 'local', name: id, state: 'live', verified: true, open: true,
  ...(needs === null ? {} : { marks: { needs, unseen: 0, working: false, session: false } satisfies TabMarks }),
})

describe('the strip\'s "<name> needs you" (A4.6 #19)', () => {
  it('nothing at launch or for a tab\'s first marks; a rise said, once a minute; a fall says nothing', () => {
    const s = needsSeen()
    const said = (tabs: TabView[], now: number, baseline = false) => needsRisen(s, [home, ...tabs], now, baseline, EVERY).map((t) => t.id)
    expect(said([tab('a', 1)], 0, true)).toEqual([])
    expect(said([tab('a', 1), tab('b', 4)], 1)).toEqual([])   // b's first marks
    expect(said([tab('a', 2), tab('b', 3)], 2)).toEqual(['a'])
    expect(said([tab('a', 5), tab('b', 3)], 3)).toEqual([])   // a: once per minute
    expect(said([tab('a', 5), tab('b', 6)], 4)).toEqual(['b'])
    expect(said([tab('a', 6), tab('b', 6)], 2 + EVERY)).toEqual(['a'])
  })

  it('a tab with no marks is forgotten: a stop as its first marks, acknowledged, then the workspace\'s first snapshot says nothing', () => {
    const s = needsSeen()
    const said = (t: TabView, now: number) => needsRisen(s, [home, t], now, false, EVERY).map((x) => x.id)
    expect(said(tab('a', 0), 0)).toEqual([])
    expect(said(tab('c', 1), 1)).toEqual([])   // killed -9 before any snapshot: the stop, first marks
    expect(said(tab('c', null), 2)).toEqual([])   // its restart's ready acknowledged it; no snapshot yet
    expect(said(tab('c', 3), 3)).toEqual([])   // the workspace's first snapshot
    expect(said(tab('c', 4), 4)).toEqual(['c'])   // a rise after it
  })
})
