import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { admissionIdle, admit, aimed, HEAD_MS, HEAP_RESUME, HEAP_SAFE, HOLD_MS, holdForCamera, onAdmissionIdle, release, resetAdmission, SLOTS } from '../src/client/shell/canvas/admission.ts'

// Frame admission: a board's iframes boot on one main thread, so at most SLOTS boot at once, one
// first, nearest the centre of the view first, and a slot goes back the moment its frame is done.

const started: string[] = []
const ask = (key: string, rank: number) => admit({ key, rank: () => rank, start: () => started.push(key) })
const settle = () => vi.advanceTimersByTimeAsync(400)   // past the first pump's settle delay

beforeEach(() => { vi.useFakeTimers(); resetAdmission(); started.length = 0 })
afterEach(() => vi.useRealTimers())

describe('admission', () => {
  it('a new batch starts ONE frame, the nearest, whatever the order they asked in; once it is done, up to SLOTS', async () => {
    for (const [k, r] of [['far', 900], ['near', 10], ['mid', 300], ['nearer', 5], ['farther', 1200], ['midder', 400]] as const) ask(k, r)
    await settle()
    expect(started).toEqual(['nearer'])
    release('nearer')
    await settle()
    expect(started).toEqual(['nearer', 'near', 'mid', 'midder', 'far'].slice(0, SLOTS + 1))
  })
  it('a released slot starts the next in rank; releasing a queued frame drops it from the queue', async () => {
    for (const [k, r] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6]] as const) ask(k, r)
    await settle()
    release('e')           // never started: leaves the queue
    release('a')           // done: its slot goes to the next by rank
    await settle()
    expect(started).toEqual(['a', 'b', 'c', 'd', 'f'])
  })
  it('ranks are read when a slot frees, not when the frame asked (the camera may have moved)', async () => {
    let rank = 100
    admit({ key: 'moving', rank: () => rank, start: () => started.push('moving') })
    for (const [k, r] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['fixed', 50]] as const) ask(k, r)
    await settle()
    rank = 0
    release('a')
    await settle()
    expect(started[1]).toBe('moving')
  })
  it('the head start is bounded: a first frame that never finishes does not hold the batch', async () => {
    for (const [k, r] of [['stalled', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) ask(k, r)
    await settle()
    expect(started).toEqual(['stalled'])
    await vi.advanceTimersByTimeAsync(HEAD_MS)
    expect(started).toEqual(['stalled', 'b', 'c', 'd'])   // the stalled one keeps its slot
  })
  it('a batch cancelled before its first pump does not admit the next batch early; asking twice is a no-op', async () => {
    ask('a', 1)
    await vi.advanceTimersByTimeAsync(300)
    release('a')                 // the board went away
    ask('b', 1)                  // a new board
    await vi.advanceTimersByTimeAsync(100)   // the old batch's pump would have fired here
    expect(started).toEqual([])
    await settle()
    expect(started).toEqual(['b'])
    ask('b', 1); await settle()
    expect(started).toEqual(['b'])
  })
  it('the camera aimed (a board\'s fit sets off): the first pick goes at once, not once the view has settled', async () => {
    for (const [k, r] of [['far', 900], ['near', 10], ['mid', 300]] as const) ask(k, r)
    await vi.advanceTimersByTimeAsync(20)
    expect(started).toEqual([])           // no aim yet: it waits for the view to settle
    aimed()
    await vi.advanceTimersByTimeAsync(0)  // the next microtask: ranked now (the ranks read where the camera will land)
    expect(started).toEqual(['near'])
    await settle()
    expect(started).toEqual(['near'])     // still one alone until it is done - and no second pump from the old wait
    release('near')
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(['near', 'mid', 'far'])
  })
  it('an aim with nothing waiting does nothing; a batch after it waits for the view as before', async () => {
    aimed()
    ask('a', 1)
    await vi.advanceTimersByTimeAsync(300)
    expect(started).toEqual([])
    await settle()
    expect(started).toEqual(['a'])
    aimed()                               // a pick already made: nothing more starts
    ask('b', 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(['a'])
  })
  it('says when it is idle - the last slot given back, or the last queued frame gone - and only then (spec 28 A1.7)', async () => {
    let heard = 0
    const off = onAdmissionIdle(() => heard++)
    ask('a', 1); ask('b', 2)
    await settle()
    expect(admissionIdle()).toBe(false)
    release('b')             // queued, never started: one is still booting
    expect(heard).toBe(0)
    release('nobody')        // not a frame it holds: nothing changes
    expect(heard).toBe(0)
    release('a')
    expect([heard, admissionIdle()]).toEqual([1, true])
    release('a')             // already gone: no second word
    expect(heard).toBe(1)
    ask('c', 1); release('c')   // a frame that only queued and left
    expect(heard).toBe(2)
    off()
  })
  it('a person moving the camera holds every new start; the boots running go on; at rest the queue goes on, ranked on the view of then', async () => {
    let rank = 100
    admit({ key: 'moving', rank: () => rank, start: () => started.push('moving') })
    for (const [k, r] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) ask(k, r)
    await settle()
    expect(started).toEqual(['a'])
    holdForCamera(true)
    release('a')                 // a slot frees mid-gesture: nothing starts in it
    await vi.advanceTimersByTimeAsync(HEAD_MS)
    expect(started).toEqual(['a'])
    rank = 0                     // the pan brought it to the centre
    holdForCamera(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(['a', 'moving', 'b', 'c', 'd'])
  })
  it('a held first pick waits for the camera too, and goes the moment it rests', async () => {
    ask('a', 1)
    holdForCamera(true)
    await settle()
    expect(started).toEqual([])
    holdForCamera(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(['a'])
  })
  it('a camera that never says it stopped holds the queue at most HOLD_MS', async () => {
    holdForCamera(true)
    ask('a', 1)
    await vi.advanceTimersByTimeAsync(HOLD_MS - 10)
    expect(started).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(started).toEqual(['a'])
  })
  describe('the heap past its safe line (performance.memory)', () => {
    // a live counter moves with every read (any allocation moves it); a bucketed one (Chromium outside a site-locked
    // process) stays put for twenty minutes
    let at = 0, live = true, reads = 0
    const memory = { get usedJSHeapSize() { reads++; return Math.round(at * 4096 * 1048576) + (live ? reads : 0) }, jsHeapSizeLimit: 4096 * 1048576 }
    const heap = (fraction: number) => { at = fraction }
    beforeEach(() => { heap(0); live = true; Object.defineProperty(performance, 'memory', { value: memory, configurable: true }) })
    afterEach(() => { delete (performance as { memory?: unknown }).memory })
    const near = new Set<string>()
    const askNear = (key: string, rank: number) => admit({ key, rank: () => rank, start: () => started.push(key), near: () => near.has(key) })
    /** a board: 'in' first (near), then the rest by rank; the heap set once 'in' is booting */
    const board = async (keys: string[], fraction: number) => {
      near.clear(); near.add('in')
      askNear('in', 0); keys.forEach((k, i) => askNear(k, i + 1))
      await settle()
      heap(fraction)
      release('in'); await vi.advanceTimersByTimeAsync(0)
    }

    it('under the line, every frame boots, near or not, in rank order - as without it', async () => {
      await board(['far1', 'far2'], HEAP_SAFE - 0.01)
      expect(started).toEqual(['in', 'far1', 'far2'])
    })
    it('past it on a live reading, a frame not near the view waits; near ones and jobs with no `near` (a stale reload) still go', async () => {
      near.add('edge')
      askNear('in', 0); askNear('far', 2); askNear('edge', 3); ask('reload', 4)
      near.add('in')
      await settle()
      heap(HEAP_SAFE + 0.01)
      release('in'); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'edge', 'reload'])
      expect(admissionIdle()).toBe(false)   // 'far' still waits: the load is not done
    })
    it('a frozen reading above the line parks nothing (a bucketed counter: twenty minutes old, maybe another board\'s)', async () => {
      live = false; heap(HEAP_SAFE + 0.2)     // the same value at every read
      await board(['far1', 'far2'], HEAP_SAFE + 0.2)
      expect(started).toEqual(['in', 'far1', 'far2'])
    })
    it('parked, nothing runs on its own: no timer, whatever the heap does meanwhile', async () => {
      await board(['a', 'b'], HEAP_SAFE + 0.01)
      await vi.advanceTimersByTimeAsync(HEAD_MS)   // the head start's own pump: still past the line
      expect(started).toEqual(['in'])
      heap(HEAP_RESUME - 0.1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(started).toEqual(['in'])
    })
    it('hysteresis: once shut, the gate opens only under HEAP_RESUME - between the two marks a far frame still waits', async () => {
      await board(['a', 'b', 'c'], HEAP_SAFE + 0.01)
      heap((HEAP_SAFE + HEAP_RESUME) / 2)
      holdForCamera(true); holdForCamera(false); await vi.advanceTimersByTimeAsync(0)   // the camera rests: asked again
      expect(started).toEqual(['in'])
      heap(HEAP_RESUME - 0.01)
      holdForCamera(true); holdForCamera(false); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'a', 'b', 'c'])
    })
    it('a parked frame boots when the camera comes near it: the gesture ends there', async () => {
      await board(['a', 'b'], HEAP_SAFE + 0.01)
      holdForCamera(true); near.add('b'); holdForCamera(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'b'])
    })
    it('a parked queue hears an aim: a link flown to a far frame boots it on landing', async () => {
      await board(['far'], HEAP_SAFE + 0.01)
      near.add('far'); aimed()
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'far'])
    })
    it('a new batch decides afresh: another board under the line boots every frame', async () => {
      await board(['a'], HEAP_SAFE + 0.01)
      release('a'); release('in')              // the board went away
      heap(HEAP_RESUME + 0.05)                 // between the marks: the old board's gate would hold
      near.clear()
      askNear('x', 1); askNear('y', 2)
      await settle(); release('x'); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'x', 'y'])
    })
  })
})
