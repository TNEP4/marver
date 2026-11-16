/**
 * Frame admission: how many iframes boot at once.
 *
 * Every frame on a board is a document booting on the ONE renderer main thread (~400 ms each for a
 * lo-fi React frame), and a batch that starts together finishes together: 64 started at once, the
 * first is ready at 25.6 s and the last at 26.0 s - the board is blank until the end. Admitted a few
 * at a time, the first is ready at 1.8 s and the board fills in view order for the same total
 * (research/hifi/bootscale.ts). The ready watchdog counts from admission, not from mount, so a
 * queued frame is never mistaken for a stalled one.
 *
 * A new batch admits ONE frame first (the quickest first content: one boot alone is ~550 ms, four
 * together ~1.8 s), then up to SLOTS at a time. Pure, apart from its timing: a board that mounts
 * registers every node, the shell aims the camera (its fit: a frame after mount at boot, 60 ms after
 * on a switch; Canvas.tsx says so through aimed()), then the first pump ranks them (visible first,
 * nearest the centre of the canvas first) on where each frame will be once the camera lands
 * (canvasCtl.landing) - it need not wait out the fit's ~320 ms flight. With no aim it waits SETTLE, as
 * long as that flight. A freed slot pumps on the next microtask, ranking again by the view of that moment.
 *
 * Nothing new starts while a person moves the camera (a pan, a zoom, a pinch: holdForCamera, from camera-broadcast's
 * `sh-camera`): a boot's main-thread work would land in the gesture's frames. The boots already running go on; when the
 * camera rests the queue goes on, ranked on the view it stopped at. A flight the shell aims (a fit, a zoom) holds
 * nothing - aimed() ranks on where it lands. Untouched, a load runs exactly as before.
 *
 * Nothing unloads, so a board too heavy for the renderer's heap would boot itself into a crash. Past HEAP_SAFE of the
 * browser's own heap limit (performance.memory, where the browser has it), a frame that is not near the view (its
 * `near`) waits: it boots when the camera comes near it - a gesture's end, an aim, a layout or window change, or at
 * the latest the next look TICK_MS later - like any frame still loading. The gate opens again under HEAP_RESUME. While it
 * is shut and frames wait, it is asked again every TICK_MS whatever else happens (one memory read and one pass over the
 * waiting frames' `near`); the events only make that sooner. A board that stays under the line boots every frame, as
 * before. The boards that change are those whose full load would sit between the gate's lines and the crash line.
 */
export const SLOTS = 4
/** A new batch's head start: one frame alone until it is done, or until this long - one stalled
 *  first frame must not hold the whole board. */
export const HEAD_MS = 2000
let primed = false   // the batch may use every slot
let gen = 0          // the batch: a pump scheduled for an earlier one is void
let timer: ReturnType<typeof setTimeout> | undefined
let settling: ReturnType<typeof setTimeout> | undefined   // a pump waiting for the view to settle (SETTLE): aimed() runs it now
let held = false     // a person moves the camera: nothing new starts (at most HOLD_MS)
let moving = false   // the camera moves under a person's hand - its rest always reconsiders the queue, held or not
let holdCap: ReturnType<typeof setTimeout> | undefined
/** The longest a gesture holds the queue: a camera that never says it stopped must not stop the board. */
export const HOLD_MS = 5000

/**
 * The heap gate's lines, fractions of the browser's own limit (jsHeapSizeLimit). Measured in headless Chrome (limit
 * 4,192 MB): a 733-frame board killed the renderer at 97% of it, its boots halving their pace past ~93%; a page that only
 * allocates died at 87% - the earliest death, the one the margin is kept from. With the gate at 0.80/0.78 the parked
 * board came to rest at 83%: the boots in flight when a collection reopens it overshoot by ~3 points. Near frames booted
 * after it (in view or half a screen off, 2-9 per approach) took up to ~5 points more. So it shuts at 0.79: 3 + 5 under
 * 87. It reopens under 0.77: wide enough that the reading's own noise between collections (about a point) does not flap
 * it, no wider - once shut, a frame boots only when a collection takes the heap under 0.77, so the fill ends where the
 * live set reaches it (measured: 25 s of boots after the first shut, then none).
 *
 * Changed, against the parent: a board whose full load would sit between 0.77 and the crash line (~3.2-3.6+ GB at this
 * limit, ~1.6-1.8 GB at a 2 GB one) keeps some far frames loading until the camera comes near them. A board whose
 * load only crosses 0.79 with its garbage ends complete - the next look after a collection reopens it. Under 0.79,
 * nothing changes. The heaviest board that fits peaks at 69% while it loads (272 frames, 2,894 MB) and settles at 50%.
 */
export const HEAP_SAFE = 0.79
export const HEAP_RESUME = 0.77
/** While the gate is shut and frames wait: how often it is asked again, whatever else happens. */
export const TICK_MS = 3000
/** Two changes of the reading this close together prove it precise (see heapGated). */
const PRECISE_MS = 60_000
let gated = false                 // past HEAP_SAFE: only near frames start, until a reading under HEAP_RESUME
let precise = false               // the page's reading has been seen to move twice within PRECISE_MS: it is exact
let memLast: number | undefined   // the last usedJSHeapSize read
let changedAt = -Infinity         // when a read last differed from the one before it
let tick: ReturnType<typeof setTimeout> | undefined
let epoch = 0                     // resetAdmission's: a collection's callback from before it does nothing
let watching = false              // a collection will pump the queue (sooner than the tick)
const collected = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry<number>((e) => { if (e !== epoch) return; watching = false; if (gated && waiting.size) schedule(0) })
  : null

/** `near`: in view or close to it, where the camera will land - a frame that may boot whatever the heap. Absent: always. */
export interface Admission { key: string; rank: () => number; start: () => void; near?: () => boolean }

const waiting = new Map<string, Admission>()
const active = new Set<string>()
let scheduled = false

/** Ask for a slot. Starts once the view has settled - the camera aimed where it will rest (aimed()), else SETTLE ms -
 *  when one is free; else queued by rank. */
export function admit(a: Admission): void {
  if (active.has(a.key)) return
  if (!waiting.size && !active.size) {   // a new batch
    primed = false; gen++; scheduled = false; gated = false; clearTimeout(timer); clearTimeout(settling); settling = undefined
    timer = setTimeout(() => { primed = true; schedule(0) }, HEAD_MS)
  }
  waiting.set(a.key, a)
  schedule(SETTLE)
}
/** The board fit animates ~320 ms from 60 ms after mount: with no aim said, the first pick waits for it to land and
 *  ranks on the settled view. */
const SETTLE = 350

/** The camera was just sent where it will rest - a fit (a board's first, ⇧1, a link's selection), a zoom, a camera
 *  restored (Canvas.tsx). A pump waiting for the view to settle runs now: its ranks read where each frame will be once
 *  the camera lands (canvasCtl.landing), so the first pick is the one SETTLE would have made, a flight earlier. */
export function aimed(): void {
  if (settling === undefined) { if (gated && waiting.size) schedule(0); return }
  clearTimeout(settling); settling = undefined; scheduled = false
  schedule(0)
}

/** A person's camera gesture started (true) or the camera rests again (false). The rest reconsiders the queue even when
 *  HOLD_MS already let the hold go: the camera may have stopped by a frame the gate keeps. */
export function holdForCamera(on: boolean): void {
  if (moving === on) return
  moving = on
  held = on
  clearTimeout(holdCap)
  if (on) holdCap = setTimeout(() => { held = false; if (waiting.size) schedule(0) }, HOLD_MS)
  else if (waiting.size) schedule(0)
}

/** What a frame is near changed without the camera moving - a layout animation ended, the window was resized: the queue
 *  is looked at again (a frame the gate keeps may be near now). */
export function reconsider(): void { if (waiting.size && !held) schedule(0) }

/** The frame is done booting (ready, error, gone, or its watchdog took over): free the slot, or
 *  leave the queue if it never started. */
export function release(key: string): void {
  const was = waiting.delete(key) || active.has(key)
  if (active.delete(key)) { primed = true; schedule(0) }
  if (was && admissionIdle()) for (const fn of idle) { try { fn() } catch { /* a listener never stops the queue */ } }
}

const idle = new Set<() => void>()
/** Nothing queued, nothing booting: a board load settles only then (spec 28 A1.7). */
export const admissionIdle = (): boolean => !waiting.size && !active.size
/** Called each time the last frame lets go of its slot or leaves the queue; returns the unsubscribe. */
export function onAdmissionIdle(fn: () => void): () => void { idle.add(fn); return () => { idle.delete(fn) } }

function schedule(ms: number): void {
  if (scheduled) return
  scheduled = true
  const g = gen, run = () => { if (g === gen) pump() }
  if (ms) settling = setTimeout(() => { settling = undefined; run() }, ms); else queueMicrotask(run)
}

/**
 * Is the heap gate shut? Only on a reading it can trust. Chromium gives performance.memory exact only to a process locked
 * to one site (cached 50 ms); elsewhere it is bucketed and refreshed at most once every twenty minutes (blink's
 * memory_info.cc). Precision is the process's, so it is proven once: two changes of the reading within PRECISE_MS - a
 * load moves an exact counter at every boot; a bucketed one changes once per twenty minutes, never twice in a minute.
 * Until then - and for good where the reading is bucketed - the gate stays open and the queue runs as it always did. A
 * proven reading is trusted even when it holds still (nothing allocated). Never where the browser does not say (Safari,
 * Firefox).
 */
function heapGated(): boolean {
  const m = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  if (!m || !(m.jsHeapSizeLimit > 0)) return (gated = false)
  const now = performance.now(), used = m.usedJSHeapSize
  if (memLast !== undefined && used !== memLast) { if (now - changedAt < PRECISE_MS) precise = true; changedAt = now }
  memLast = used
  if (!precise) return (gated = false)
  if (used > HEAP_SAFE * m.jsHeapSizeLimit) gated = true
  else if (used < HEAP_RESUME * m.jsHeapSizeLimit) gated = false
  return gated
}

function pump(): void {
  scheduled = false
  clearTimeout(tick); tick = undefined
  if (!waiting.size) return
  const high = heapGated()   // every pump reads it: an exact counter proves itself within a load's first boots
  while (!held && active.size < (primed ? SLOTS : 1) && waiting.size) {
    let best: Admission | undefined, bestRank = Infinity
    for (const a of waiting.values()) {
      if (high && a.near && !a.near()) continue
      const r = a.rank(); if (r < bestRank || !best) { best = a; bestRank = r }
    }
    if (!best) {   // parked: asked again at the next tick at the latest, sooner on a collection
      const g = gen
      tick = setTimeout(() => { tick = undefined; if (g === gen) pump() }, TICK_MS)
      if (collected && !watching) { watching = true; collected.register({}, epoch) }
      return
    }
    waiting.delete(best!.key)
    active.add(best!.key)
    ;(globalThis as { __mvAdmitted?: string[] }).__mvAdmitted?.push(best!.key)   // diagnostic: the order, when a probe asks for it
    best!.start()
  }
}

/** For tests: nothing queued, nothing active. */
export function resetAdmission(): void { waiting.clear(); active.clear(); primed = false; scheduled = false; gen++; clearTimeout(timer); clearTimeout(settling); settling = undefined; held = false; moving = false; clearTimeout(holdCap); clearTimeout(tick); tick = undefined; gated = false; precise = false; memLast = undefined; changedAt = -Infinity; watching = false; epoch++ }

// a hot-replaced module leaves no timer of its own behind
if (import.meta.hot) import.meta.hot.dispose(() => { clearTimeout(timer); clearTimeout(settling); clearTimeout(holdCap); clearTimeout(tick); epoch++ })
