import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// a collection's callback (FinalizationRegistry) has no deadline and no guarantee: the queue runs here without one, so
// nothing below depends on it - and a real collection during a test cannot rescue a stall it should show
vi.hoisted(() => { (globalThis as { FinalizationRegistry?: unknown }).FinalizationRegistry = undefined })
import { admissionIdle, admit, aimed, HEAD_MS, disposeAdmission, HEAP_RESUME, HEAP_SAFE, onAdmissionIdle, readable, reconsider, TICK_MS, wireAdmission, release, resetAdmission, SLOTS } from '../src/client/shell/canvas/admission.ts'

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
  it('a person\'s gesture stops nothing: a frame waiting with a slot free starts at once, as on the parent', async () => {
    const motion = new Set<(m: { camera: boolean; preset: boolean }) => void>()
    const unwire = wireAdmission((fn) => { motion.add(fn); return () => motion.delete(fn) }, new EventTarget(), Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    for (const [k, r] of [['a', 1], ['b', 2]] as const) ask(k, r)
    await settle()
    for (const fn of motion) fn({ camera: true, preset: false })   // a pan starts
    release('a')                                                    // a slot frees mid-gesture
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(['a', 'b'])
    unwire()
  })
  it('under the line a look (the camera at rest, a resize, the page shown) does nothing: no pump, no memory read', async () => {
    let reads = 0
    Object.defineProperty(performance, 'memory', { configurable: true, get: () => { reads++; return { usedJSHeapSize: 0.1 * 4096 * 1048576 + reads, jsHeapSizeLimit: 4096 * 1048576 } } })
    try {
      for (const [k, r] of [['a', 1], ['b', 2]] as const) ask(k, r)
      await settle()
      expect(started).toEqual(['a'])     // the head start: one slot, taken; 'b' waits
      const before = reads
      reconsider(); await vi.advanceTimersByTimeAsync(0)
      expect(reads).toBe(before)         // no pump ran: the parent's queue, untouched
      expect(started).toEqual(['a'])
    } finally { delete (performance as { memory?: unknown }).memory }
  })
  describe('the heap past its safe line (performance.memory)', () => {
    // Chromium's sample, shared by every reader of the page (blink memory_info.cc): refreshed on a read at most every 50 ms
    // when exact (a site-locked process), every twenty minutes when bucketed; the heap itself moves with any allocation
    const LIMIT = 4096 * 1048576
    let at = 0, precise = true, frozen = 0, sample = 0, sampledAt = -Infinity
    const heapNow = () => Math.round(at * LIMIT) + Math.floor(performance.now())   // allocation never quite stops
    const memory = {
      get usedJSHeapSize() {
        if (!precise) return frozen
        const now = performance.now()
        if (now - sampledAt >= 50) { sample = heapNow(); sampledAt = now }
        return sample
      },
      jsHeapSizeLimit: LIMIT,
    }
    const heap = (fraction: number) => { at = fraction; sampledAt = -Infinity }
    const refresh = (fraction: number) => { frozen = Math.round(fraction * LIMIT) }   // a bucketed sample's refresh
    beforeEach(() => { heap(0); precise = true; refresh(0); Object.defineProperty(performance, 'memory', { value: memory, configurable: true }) })
    afterEach(() => { delete (performance as { memory?: unknown }).memory })
    const near = new Set<string>()
    const askNear = (key: string, rank: number) => admit({ key, rank: () => rank, start: () => started.push(key), near: () => near.has(key) })
    /** 'in' booting past the head start (its pump is spent), the reading proven by a few pumps; then the heap, then the
     *  rest of the board asks in - Codex's case: nothing left that would pump on its own */
    /** pumps that read the heap, as a load's own do: a frame asks (its pump comes SETTLE later) and leaves again */
    const readings = async (n: number) => { for (let i = 0; i < n; i++) { const k = `r${i}`; admit({ key: k, rank: () => 9, start: () => {} }); await vi.advanceTimersByTimeAsync(400); release(k) } }
    const start = async () => {
      near.clear(); near.add('in')
      askNear('in', 0)
      admit({ key: 'w', rank: () => 0.5, start: () => {} })   // another frame of the load: it waits, then holds a slot
      await settle()                                           // 'in' alone (the head start)
      await readings(2)
      await vi.advanceTimersByTimeAsync(HEAD_MS)               // the head start's pump, spent: 'w' takes a slot
    }
    const board = async (keys: string[], fraction: number) => {
      await start()
      heap(fraction)
      keys.forEach((k, i) => askNear(k, i + 1))
      await settle()
      release('in'); await vi.advanceTimersByTimeAsync(0)
    }
    const past = HEAP_SAFE + 0.01, between = (HEAP_SAFE + HEAP_RESUME) / 2, under = HEAP_RESUME - 0.01

    it('under the line, every frame boots, near or not, in rank order - as without it', async () => {
      await board(['far1', 'far2'], HEAP_SAFE - 0.01)
      expect(started).toEqual(['in', 'far1', 'far2'])
    })
    it('past it, a frame not near the view waits; near ones and jobs with no `near` (a stale reload) still go', async () => {
      await start()
      heap(past)
      near.add('edge')
      askNear('far', 2); askNear('edge', 3); ask('reload', 4)
      await settle()
      release('in'); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'edge', 'reload'])
      expect(admissionIdle()).toBe(false)   // 'far' still waits: the load is not done
    })
    it('a bucketed reading that refreshes once above the line and freezes parks nothing: one change is no proof', async () => {
      precise = false; refresh(0.1)
      await start()                          // the same bucket at every read
      refresh(past)                          // its twenty-minute refresh lands above the line, then holds
      askNear('far1', 1); askNear('far2', 2)
      await settle()
      release('in'); await vi.advanceTimersByTimeAsync(TICK_MS * 4)
      expect(started).toEqual(['in', 'far1', 'far2'])
    })
    it('a board that only spikes past the line while it loads and settles under the reopen line finishes on its own: no event at all, the tick reopens it', async () => {
      await board(['a', 'b'], past)
      expect(started).toEqual(['in'])
      heap(under)                            // collected: nobody says so
      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(started).toEqual(['in', 'a', 'b'])
    })
    it('a spike, then a plateau between the lines: the board stays parked - its far frames wait for the camera (the band that changes) - and go if it ever falls under', async () => {
      await board(['a', 'b'], past)
      heap(between)
      await vi.advanceTimersByTimeAsync(TICK_MS * 5)
      expect(started).toEqual(['in'])
      expect(admissionIdle()).toBe(false)
      heap(under)
      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(started).toEqual(['in', 'a', 'b'])
    })
    it('a proven reading that holds still is still trusted: parked stays parked', async () => {
      await board(['a'], past)
      precise = false; refresh(past)         // nothing allocates at rest: the same exact value at every read
      await vi.advanceTimersByTimeAsync(TICK_MS * 5)
      expect(started).toEqual(['in'])
    })
    it('a parked frame brought near with no camera event (tidy, a resize, a dragged frame) boots by the next tick; reconsider() at once', async () => {
      await board(['a', 'b'], past)
      near.add('a')
      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(started).toEqual(['in', 'a'])
      near.add('b'); reconsider()
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'a', 'b'])
    })
    it('a parked frame boots when the camera comes to rest by it (the wiring\'s look at the rest)', async () => {
      await board(['a', 'b'], past)
      near.add('b'); reconsider()
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'b'])
    })
    it('a parked queue hears an aim: a link flown to a far frame boots it on landing', async () => {
      await board(['far'], past)
      near.add('far'); aimed()
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'far'])
    })
    it('nothing runs while nothing waits: the tick stops when the parked frames leave', async () => {
      await board(['a'], past)
      expect(vi.getTimerCount()).toBeGreaterThan(0)   // parked: the tick
      release('a')                                    // the board went away
      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(vi.getTimerCount()).toBe(0)
    })
    it('a new batch decides afresh: another board under the line boots every frame', async () => {
      await board(['a'], past)
      release('a'); release('w')               // the board went away
      heap(between)                            // between the marks: the old board's gate would hold
      near.clear()
      askNear('x', 1); askNear('y', 2)
      await settle(); release('x'); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in', 'x', 'y'])
    })

    it('a bucketed sample seen across a gap in admission\'s own reads proves nothing (Codex r2): another reader refreshed it meanwhile', async () => {
      precise = false; refresh(0.1)
      const MIN = 60_000
      await start()                                 // admission reads bucket A, then its queue empties
      release('w'); release('in')
      await vi.advanceTimersByTimeAsync(20 * MIN)   // another reader (the recorder) refreshes the sample to B
      refresh(0.2)
      await vi.advanceTimersByTimeAsync(19 * MIN + 50_000)
      near.clear(); near.add('in')
      askNear('in', 0); admit({ key: 'w', rank: () => 0.5, start: () => {} })   // a new batch at 39:50 first sees B: change one
      await settle()
      await vi.advanceTimersByTimeAsync(11_000)     // its head start spent: 'in' and 'w' booting
      refresh(past)                                 // 40:01: the sample's next refresh, above the line: change two, 11 s on
      askNear('far1', 1); askNear('far2', 2)
      await settle()
      release('in'); await vi.advanceTimersByTimeAsync(TICK_MS * 3)
      expect(started.filter((k) => k !== 'in')).toEqual(['far1', 'far2'])
    })
    it('an exact sample (cached 50 ms) proves itself within a load\'s first boots', async () => {
      near.clear(); near.add('in')
      askNear('in', 0); admit({ key: 'w', rank: () => 0.5, start: () => {} })
      await settle()
      await readings(3)                             // a load's pumps, a few hundred ms apart
      await vi.advanceTimersByTimeAsync(HEAD_MS)
      heap(past)
      askNear('far', 1)
      await settle()
      release('in'); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in'])               // proven: past the line, the far frame waits
    })
    it('a hot-replaced module leaves nothing behind: not its parked tick, not a pump already queued', async () => {
      await board(['far'], past)
      expect(vi.getTimerCount()).toBeGreaterThan(0)   // parked: the tick
      reconsider()                 // a pump queued...
      disposeAdmission()           // ...and the module replaced before it runs
      await vi.advanceTimersByTimeAsync(TICK_MS * 3)
      expect(vi.getTimerCount()).toBe(0)
      expect(started).toEqual(['in'])
    })
    it('readable: past the line a frame boots on screen or near it, by its larger side, no smaller than image-LOD\'s first bucket', () => {
      const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h })
      const c = rect(0, 0, 1600, 1000)
      const big = { width: 1440, height: 900 }   // a desktop frame, world px
      expect(readable(rect(100, 100, 200, 120), c, 2, big)).toBe(true)      // 400 device px, in view
      expect(readable(rect(100, 100, 100, 60), c, 2, big)).toBe(false)      // 200 device px: a thumbnail
      expect(readable(rect(100, 100, 100, 60), c, 3, big)).toBe(false)      // the ratio counts up to 2, as image-LOD's does
      expect(readable(rect(1900, 100, 400, 240), c, 1, big)).toBe(true)     // half a screen off, readable
      expect(readable(rect(2500, 100, 400, 240), c, 1, big)).toBe(false)    // further
      expect(readable(rect(100, 100, 70, 280), c, 1, { width: 200, height: 800 })).toBe(true)   // tall and narrow: read by its height
    })
    it('readable: a frame too small ever to reach the bucket boots at the closest the ordinary camera goes (Codex r3)', () => {
      const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h })
      const c = rect(0, 0, 1600, 1000)
      // a 24 px frame: 96 device px at 2x zoom on a 2x display, the most it can be
      expect(readable(rect(100, 100, 48, 48), c, 2, { width: 24, height: 24 })).toBe(true)
      expect(readable(rect(100, 100, 24, 24), c, 2, { width: 24, height: 24 })).toBe(false)        // at 1x it is a thumbnail of itself: come closer
      // a frame at the UI's 120 px minimum on a 1x display: 240 px at 2x zoom
      expect(readable(rect(100, 100, 240, 240), c, 1, { width: 120, height: 120 })).toBe(true)
    })
    it('readable: a strip is read by both sides (Codex r4) - 24x6000 world px at 5% is a line, not a frame; at 2x it is', () => {
      const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h })
      const c = rect(0, 0, 1600, 1000)
      const strip = { width: 24, height: 6000 }
      expect(readable(rect(100, 100, 1.2, 300), c, 1, strip)).toBe(false)   // 1.2 x 300 px: 733 of them fit the screen
      expect(readable(rect(100, 100, 48, 12000), c, 2, strip)).toBe(true)   // at the ordinary camera's closest it boots
    })
  })


  it('the Canvas wiring, while the gate is shut: the camera\'s rest, a layout animation\'s end, a resize and the page shown again look again', async () => {
    const motion = new Set<(m: { camera: boolean; preset: boolean }) => void>()
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    const unwire = wireAdmission((fn) => { motion.add(fn); return () => motion.delete(fn) }, win, doc)
    const send = (m: { camera: boolean; preset: boolean }) => { for (const fn of motion) fn(m) }
    let pumps = 0
    const probe = (k: string) => admit({ key: k, rank: () => 1, start: () => started.push(k), near: () => { pumps++; return false } })
    Object.defineProperty(performance, 'memory', { configurable: true, get: () => ({ usedJSHeapSize: 0.9 * 4096 * 1048576 + Math.floor(performance.now()), jsHeapSizeLimit: 4096 * 1048576 }) })
    try {
      ask('in', 0); probe('far')
      await settle()
      for (let i = 0; i < 3; i++) { const k = `r${i}`; admit({ key: k, rank: () => 9, start: () => {} }); await vi.advanceTimersByTimeAsync(400); release(k) }
      release('in'); await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['in'])                    // parked: 'far' is not near
      const looks = async (fire: () => void) => { const p = pumps; fire(); await vi.advanceTimersByTimeAsync(0); return pumps > p }
      expect(await looks(() => send({ camera: true, preset: false }))).toBe(false)    // a gesture starting: nothing to look at yet
      expect(await looks(() => send({ camera: false, preset: false }))).toBe(true)    // its rest looks again
      expect(await looks(() => send({ camera: false, preset: true }))).toBe(false)    // a layout animation running
      expect(await looks(() => send({ camera: false, preset: false }))).toBe(true)    // ...and ended (tidy)
      expect(await looks(() => win.dispatchEvent(new Event('resize')))).toBe(true)
      expect(await looks(() => doc.dispatchEvent(new Event('visibilitychange')))).toBe(false)   // hidden: nothing
      doc.visibilityState = 'visible'
      expect(await looks(() => doc.dispatchEvent(new Event('visibilitychange')))).toBe(true)    // shown again
      unwire()
      expect(await looks(() => win.dispatchEvent(new Event('resize')))).toBe(false)
    } finally { delete (performance as { memory?: unknown }).memory }
  })
})
