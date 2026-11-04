import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootCommitted, watchInplace } from '../src/client/frame-host/inplace.ts'
import { RELOAD_BOUNDS } from '../src/shared/perf-records.ts'

/**
 * Spec 30 #15's watch on an update round, with Vite's two events and the browser's observer faked: a round holds what its
 * own updates left and no more, and it ends whether or not `vite:afterUpdate` comes - an accept callback that throws
 * means none (Vite's client.mjs). The real thing, end to end: test/r30-edits-reloads-browser.test.ts.
 */

class FakeObserver {
  static all: FakeObserver[] = []
  disconnected = false
  constructor(private cb: (list: { getEntries(): PerformanceEntry[] }) => void) { FakeObserver.all.push(this) }
  observe() {}
  disconnect() { this.disconnected = true }
  pending: PerformanceEntry[] = []
  takeRecords(): PerformanceEntry[] { return this.pending.splice(0) }
  deliver(entries: PerformanceEntry[]) { this.cb({ getEntries: () => entries }) }
}
const live = () => FakeObserver.all.at(-1)!

const UPDATE = { type: 'js-update', path: '/design/a.tsx', acceptedPath: '/design/a.tsx', timestamp: 5000 }
const OF_UPDATE = 'http://localhost/design/a.tsx?t=5000'
/** A resource entry that says when its name is read: one read and let go is one read, ever. */
const entry = (name: string, reads = { n: 0 }) => ({ get name() { reads.n++; return name } } as unknown as PerformanceEntry)

let events: Record<string, (p?: any) => void>
let posted: Record<string, unknown>[]
const error0 = console.error
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('PerformanceObserver', FakeObserver)
  FakeObserver.all = []
  events = {}
  posted = []
  console.error = vi.fn()
  watchInplace({ on: (ev, cb) => { events[ev] = cb } }, (m) => posted.push(m as never))
})
afterEach(() => { rootCommitted(); console.error = error0; vi.useRealTimers(); vi.unstubAllGlobals() })
const before = (updates: unknown[] = [UPDATE]) => events['vite:beforeUpdate']!({ updates })
const after = () => events['vite:afterUpdate']!()

describe('an update round (#15)', () => {
  it('no `afterUpdate`: past its limit the observer is gone and console.error is back, with nothing left running', () => {
    const was = console.error
    before()
    expect(console.error).not.toBe(was)
    expect(live().disconnected).toBe(false)
    vi.advanceTimersByTime(RELOAD_BOUNDS.inplaceRoundMs - 1)
    expect(live().disconnected).toBe(false)
    vi.advanceTimersByTime(1)
    expect(live().disconnected).toBe(true)
    expect(console.error).toBe(was)
    expect(vi.getTimerCount()).toBe(0)
    // its late `afterUpdate` has no round to report
    after()
    expect(posted).toEqual([])
  })

  describe('with no `afterUpdate`: what was known is written, once', () => {
    const OTHER = { ...UPDATE, path: '/design/b.tsx', acceptedPath: '/design/b.tsx', timestamp: 6000 }
    const NEVER = { ...UPDATE, path: '/design/c.tsx', acceptedPath: '/design/c.tsx', timestamp: 7000 }
    it('at the limit: one record per update fetched by then, the flag on each, `applyMs` the time it stood open', () => {
      before([UPDATE, OTHER, NEVER])
      live().deliver([entry(OF_UPDATE)])
      live().pending.push(entry('http://localhost/design/b.tsx?t=6000'))   // fetched, not yet told: read at the end
      vi.advanceTimersByTime(RELOAD_BOUNDS.inplaceRoundMs)
      expect(posted).toEqual([
        { type: 'sh:inplace', hmrTs: 5000, applyMs: RELOAD_BOUNDS.inplaceRoundMs, applied: 'unknown', noAfterUpdate: true },
        { type: 'sh:inplace', hmrTs: 6000, applyMs: RELOAD_BOUNDS.inplaceRoundMs, applied: 'unknown', noAfterUpdate: true },
      ])
      expect(live().disconnected).toBe(true)
    })
    it('a later `afterUpdate` for that round writes nothing more', async () => {
      before()
      live().deliver([entry(OF_UPDATE)])
      vi.advanceTimersByTime(RELOAD_BOUNDS.inplaceRoundMs)
      expect(posted).toHaveLength(1)
      after()
      rootCommitted()
      await vi.advanceTimersByTimeAsync(RELOAD_BOUNDS.commitWaitMs)
      expect(posted).toHaveLength(1)
    })
    it('Vite\'s failure for its path was known too: `applied: false`', () => {
      before()
      live().deliver([entry(OF_UPDATE)])
      console.error('Failed to reload /design/a.tsx. something')
      vi.advanceTimersByTime(RELOAD_BOUNDS.inplaceRoundMs)
      expect(posted).toEqual([expect.objectContaining({ hmrTs: 5000, applied: false, noAfterUpdate: true })])
    })
    it('the next update ends it the same way, at once, and its own round goes on', async () => {
      before()
      live().deliver([entry(OF_UPDATE)])
      vi.advanceTimersByTime(1000)
      before([OTHER])
      expect(posted).toEqual([{ type: 'sh:inplace', hmrTs: 5000, applyMs: 1000, applied: 'unknown', noAfterUpdate: true }])
      live().deliver([entry('http://localhost/design/b.tsx?t=6000')])
      after()
      rootCommitted()
      await vi.advanceTimersByTimeAsync(0)
      expect(posted).toHaveLength(2)
      expect(posted[1]).toMatchObject({ hmrTs: 6000 })
      expect(posted[1]).not.toHaveProperty('noAfterUpdate')
    })
    it('nothing fetched: nothing to say', () => {
      before([UPDATE, OTHER])
      vi.advanceTimersByTime(RELOAD_BOUNDS.inplaceRoundMs)
      expect(posted).toEqual([])
    })
  })

  it('a frame\'s own console.error set meanwhile stays; the watch inside it has stopped listening', () => {
    before()
    const watching = console.error
    const frames = vi.fn((...a: unknown[]) => watching(...a))
    console.error = frames as never
    vi.advanceTimersByTime(RELOAD_BOUNDS.inplaceRoundMs)
    expect(console.error).toBe(frames)
    console.error('Failed to reload /design/a.tsx. something')
    expect(frames).toHaveBeenCalledTimes(1)
  })

  it('every other resource of the document is read once and let go: a flood keeps nothing', () => {
    before()
    const reads = { n: 0 }
    for (let i = 0; i < 2000; i++) live().deliver([entry(`http://localhost/assets/${i}.png`, reads)])
    expect(reads.n).toBe(2000)
    const hit = { n: 0 }
    live().deliver([entry(OF_UPDATE, hit)])
    after()
    expect(reads.n, 'nothing kept to read again at the round\'s end').toBe(2000)
    expect(hit.n).toBe(1)
  })

  it('what fetched its update is still seen, and a report follows; one that did not writes nothing', async () => {
    before([UPDATE, { ...UPDATE, path: '/design/b.tsx', acceptedPath: '/design/b.tsx', timestamp: 6000 }])
    live().deliver([entry('http://localhost/assets/x.png'), entry(OF_UPDATE)])
    after()
    rootCommitted()
    await vi.advanceTimersByTimeAsync(0)
    expect(posted).toEqual([expect.objectContaining({ type: 'sh:inplace', hmrTs: 5000, applied: 'unknown' })])
    expect(live().disconnected).toBe(true)
    expect(vi.getTimerCount(), 'the round\'s limit went with it').toBe(0)
  })

  it('Vite\'s failure for this round\'s path says `applied: false`; another path\'s is not kept', async () => {
    before()
    console.error('Failed to reload /design/other.tsx. something')
    live().deliver([entry(OF_UPDATE)])
    after()
    rootCommitted()
    await vi.advanceTimersByTimeAsync(0)
    expect(posted).toEqual([expect.objectContaining({ applied: 'unknown' })])
    posted = []
    before()
    console.error('Failed to reload /design/a.tsx. something')
    live().deliver([entry(OF_UPDATE)])
    after()
    rootCommitted()
    await vi.advanceTimersByTimeAsync(0)
    expect(posted).toEqual([expect.objectContaining({ applied: false })])
  })

  it('the next update closes a round that never ended', () => {
    before()
    const first = live()
    before()
    expect(first.disconnected).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })
})
