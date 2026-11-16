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
 * `near`) waits: it boots when the camera comes near it - a gesture's end, an aim, or the slow look PARK_MS later -
 * like any frame still loading. A board that stays under the line boots every frame, as before.
 */
export const SLOTS = 4
/** A new batch's head start: one frame alone until it is done, or until this long - one stalled
 *  first frame must not hold the whole board. */
export const HEAD_MS = 2000
let primed = false   // the batch may use every slot
let gen = 0          // the batch: a pump scheduled for an earlier one is void
let timer: ReturnType<typeof setTimeout> | undefined
let settling: ReturnType<typeof setTimeout> | undefined   // a pump waiting for the view to settle (SETTLE): aimed() runs it now
let held = false     // a person moves the camera: nothing new starts
let holdCap: ReturnType<typeof setTimeout> | undefined
/** The longest a gesture holds the queue: a camera that never says it stopped must not stop the board. */
export const HOLD_MS = 5000

/** The heap's safe line, a fraction of the browser's own limit (jsHeapSizeLimit). Measured in headless Chrome (limit
 *  4,192 MB): a 733-frame board killed the renderer at 97% of it, boots halving their pace past ~93%; a page that only
 *  allocates died at 87%. The heaviest board that fits peaks at 66% while it loads (272 frames, 2,769 MB before a
 *  collection, 50% after). PARK_MS: how often a parked queue looks again - the heap falls after a collection. */
export const HEAP_SAFE = 0.75
export const PARK_MS = 2000
let parked: ReturnType<typeof setTimeout> | undefined

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
    primed = false; gen++; scheduled = false; clearTimeout(timer); clearTimeout(settling); settling = undefined
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
  if (settling === undefined) { if (parked !== undefined) schedule(0); return }
  clearTimeout(settling); settling = undefined; scheduled = false
  schedule(0)
}

/** A person's camera gesture started (true) or the camera rests again (false). */
export function holdForCamera(on: boolean): void {
  if (held === on) return
  held = on
  clearTimeout(holdCap)
  if (on) holdCap = setTimeout(() => holdForCamera(false), HOLD_MS)
  else if (waiting.size) schedule(0)
}

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

/** Is the heap past its safe line? Never where the browser does not say (Safari, Firefox). */
function heapHigh(): boolean {
  const m = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  return !!m && m.jsHeapSizeLimit > 0 && m.usedJSHeapSize > HEAP_SAFE * m.jsHeapSizeLimit
}

function pump(): void {
  scheduled = false
  clearTimeout(parked); parked = undefined
  let high: boolean | undefined
  while (!held && active.size < (primed ? SLOTS : 1) && waiting.size) {
    high ??= heapHigh()
    let best: Admission | undefined, bestRank = Infinity
    for (const a of waiting.values()) {
      if (high && a.near && !a.near()) continue
      const r = a.rank(); if (r < bestRank || !best) { best = a; bestRank = r }
    }
    if (!best) { const g = gen; parked = setTimeout(() => { parked = undefined; if (g === gen) pump() }, PARK_MS); return }
    waiting.delete(best!.key)
    active.add(best!.key)
    ;(globalThis as { __mvAdmitted?: string[] }).__mvAdmitted?.push(best!.key)   // diagnostic: the order, when a probe asks for it
    best!.start()
  }
}

/** For tests: nothing queued, nothing active. */
export function resetAdmission(): void { waiting.clear(); active.clear(); primed = false; scheduled = false; gen++; clearTimeout(timer); clearTimeout(settling); settling = undefined; held = false; clearTimeout(holdCap); clearTimeout(parked); parked = undefined }
