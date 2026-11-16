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
 * The gate is no absolute ceiling: a board with hundreds of frames all readable in view at once still boots them, as on
 * the parent - it holds back only what the person cannot be looking at.
 *
 * Under the heap's line, with or without a gesture, admission is the parent's exactly: a person's pan or zoom stops
 * nothing (holding boots through a gesture was measured and set aside as a candidate for the owner - it trades frames
 * in view arriving about half the pan's length later for a smoother pan: perf/loop/candidates/i10-gesture-hold).
 *
 * Nothing unloads, so a board too heavy for the renderer's heap would boot itself into a crash. Past HEAP_SAFE of the
 * browser's own heap limit (performance.memory, where the browser has it), a frame that is not near the view (its
 * `near`) waits: it boots when the camera comes near it - a gesture's end, an aim, a layout or window change, or at
 * the latest the next look TICK_MS later - like any frame still loading. The gate opens again under HEAP_RESUME. While it
 * is shut and frames wait, it is asked again every TICK_MS whatever else happens (one memory read and one pass over the
 * waiting frames' `near`); the events only make that sooner. A board that stays under the line boots every frame, as
 * before. The boards that change are those whose full load would sit between the gate's lines and the crash line.
 */
import { LOD_MIN_PX, ZOOM_MAX } from '../../const.ts'

export const SLOTS = 4
/** A new batch's head start: one frame alone until it is done, or until this long - one stalled
 *  first frame must not hold the whole board. */
export const HEAD_MS = 2000
let primed = false   // the batch may use every slot
let gen = 0          // the batch: a pump scheduled for an earlier one is void
let timer: ReturnType<typeof setTimeout> | undefined
let settling: ReturnType<typeof setTimeout> | undefined   // a pump waiting for the view to settle (SETTLE): aimed() runs it now

/**
 * The heap gate's lines, fractions of the browser's own limit (jsHeapSizeLimit), measured in headless Chrome (limit
 * 4,192 MB). The crash: a 733-frame board killed the renderer at 97% of it, its boots halving their pace past ~93% (a
 * page that only allocates died at 87%). A load's own transient: the heaviest board that fits (272 frames) peaks at 69%
 * while it loads and settles at 50% - 19 points of garbage on top of its live heap. Shut at 0.75, reopened under 0.60,
 * the parked 733-frame board comes to rest at 61-65%, and each approach to its parked frames (2-9 near frames) adds
 * ~1-2 points live, up to ~5 transient: room for one load-sized transient on top of the rest, and some 30 approaches
 * before the 97% line. Narrower lines (0.79/0.77) left that board at 81% and six approaches took it to 88% - less room
 * than one transient; a crash is the worst outcome, a board that stops short and boots the rest on approach the mild one.
 *
 * Changed, against the parent: a board whose live heap after loading would exceed ~60% of the limit (~2.5 GB here,
 * ~1.2 GB at a 2 GB limit) stops there and boots the rest as the camera approaches. One that only spikes past 0.75 while
 * it loads and settles under 0.60 finishes on its own: the next look (TICK_MS) after a collection reopens the gate. One
 * that plateaus between the lines stays parked: its far frames boot on approach. Under 0.75, nothing changes.
 */
export const HEAP_SAFE = 0.75
export const HEAP_RESUME = 0.6
/** While the gate is shut and frames wait: how often it is asked again, whatever else happens. One look reads every
 *  waiting frame's iframe as drawn (getBoundingClientRect, one canvas rect per pass): 6.0-6.9 ms on the parked 733-frame
 *  archive (~460 waiting), about 11 ms per 5 s - and only on a board the gate has parked. */
export const TICK_MS = 3000
/** Two changes of the reading known to lie within this window prove it precise (see heapGated). */
const PRECISE_MS = 60_000
let gated = false                 // past HEAP_SAFE: only near frames start, until a reading under HEAP_RESUME
let precise = false               // the page's reading has been seen to move twice within PRECISE_MS: it is exact
let memLast: number | undefined   // the last usedJSHeapSize read
let readAt = -Infinity            // when admission last read it
let changeFrom = -Infinity        // the earliest the last change seen can have happened: the read before it
let tick: ReturnType<typeof setTimeout> | undefined
let epoch = 0                     // resetAdmission's: a collection's callback from before it does nothing
let watching = false              // a collection will pump the queue (sooner than the tick)
const collected = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry<number>((e) => { if (e !== epoch) return; watching = false; if (gated && waiting.size) schedule(0) })
  : null

/** A readable frame's smaller side on screen, device px: 16 CSS px at a 2x display - about one line of text; a strip
 *  thinner than that shows nothing to read whatever its length. */
const STRIP_MIN_PX = 32
/** Past the heap's line, may a frame boot? Its iframe on screen where the camera lands (r), against the canvas (c): in
 *  view or within half a screen of it (updates.ts's margin), and large enough to be read on both sides - the larger at
 *  least image-LOD's smallest decode width (LOD_MIN_PX device px), the smaller at least STRIP_MIN_PX - each bar capped at
 *  what the ordinary camera can make of that side (its world size, `world`, at ZOOM_MAX), so every frame stays reachable
 *  by moving the camera to it. A thumbnail on a zoomed-out board waits until the camera comes closer. */
export function readable(r: Box, c: Box, dpr: number, world: { width: number; height: number }): boolean {
  const k = Math.min(dpr || 1, 2), mx = c.width / 2, my = c.height / 2
  const big = Math.max(r.width, r.height) * k, small = Math.min(r.width, r.height) * k
  const reach = (side: number) => side * ZOOM_MAX * k - 0.5
  return big >= Math.min(LOD_MIN_PX - 0.5, reach(Math.max(world.width, world.height)))
    && small >= Math.min(STRIP_MIN_PX - 0.5, reach(Math.min(world.width, world.height)))
    && r.right > c.left - mx && r.left < c.right + mx && r.bottom > c.top - my && r.top < c.bottom + my
}
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }

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

/** What a frame is near may have changed - the camera came to rest, a layout animation ended, the window was resized, the
 *  page was shown again: while the heap gate is shut, the queue is looked at again (a frame it keeps may be near now).
 *  Under the line it does nothing - admission there is the parent's. */
export function reconsider(): void { if (gated && waiting.size) schedule(0) }

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
  // a change seen now happened after the read before it: two changes prove a fast counter only if both lie, for sure,
  // inside PRECISE_MS - from the earlier one's lower bound to now. A gap in admission's own reads (the queue empty while
  // another reader, or time, refreshed Chromium's shared sample) proves nothing.
  if (memLast !== undefined && used !== memLast) { if (now - changeFrom < PRECISE_MS) precise = true; changeFrom = readAt }
  memLast = used; readAt = now
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
  while (active.size < (primed ? SLOTS : 1) && waiting.size) {
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
export function resetAdmission(): void { waiting.clear(); active.clear(); primed = false; scheduled = false; gen++; clearTimeout(timer); clearTimeout(settling); settling = undefined; clearTimeout(tick); tick = undefined; gated = false; precise = false; memLast = undefined; readAt = -Infinity; changeFrom = -Infinity; watching = false; epoch++ }

/** A hot-replaced module leaves nothing of its own behind: no timer, and no pump already queued (its batch is void). */
export function disposeAdmission(): void {
  clearTimeout(timer); clearTimeout(settling); settling = undefined; clearTimeout(tick); tick = undefined
  gen++; scheduled = false; epoch++
}
if (import.meta.hot) import.meta.hot.dispose(disposeAdmission)

/** Canvas.tsx's wiring, in one place (tested): what a frame is near changing - the camera at rest, a layout animation's
 *  end, a resize, the page shown again (a hidden page's timers run once a minute) - looks again. Returns the unwiring. */
export function wireAdmission(
  onMotion: (fn: (m: { camera: boolean; preset: boolean }) => void) => () => void,
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState: string },
): () => void {
  const off = onMotion((m) => { if (!m.camera && !m.preset) reconsider() })
  const shown = () => { if (doc.visibilityState === 'visible') reconsider() }
  win.addEventListener('resize', reconsider)
  doc.addEventListener('visibilitychange', shown)
  return () => { off(); win.removeEventListener('resize', reconsider); doc.removeEventListener('visibilitychange', shown) }
}
