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
 * registers every node, the shell fits the camera (App.tsx, a few tens of ms later), then the first
 * pump ranks them (visible first, nearest the centre of the canvas first); a freed slot pumps on
 * the next microtask, ranking again by the view of that moment.
 */
export const SLOTS = 4
/** A new batch's head start: one frame alone until it is done, or until this long - one stalled
 *  first frame must not hold the whole board. */
export const HEAD_MS = 2000
let primed = false   // the batch may use every slot
let gen = 0          // the batch: a pump scheduled for an earlier one is void
let timer: ReturnType<typeof setTimeout> | undefined

export interface Admission { key: string; rank: () => number; start: () => void }

const waiting = new Map<string, Admission>()
const active = new Set<string>()
let scheduled = false

/** Ask for a slot. Starts once the view has settled (SETTLE ms) when one is free; else queued by rank. */
export function admit(a: Admission): void {
  if (active.has(a.key)) return
  if (!waiting.size && !active.size) {   // a new batch
    primed = false; gen++; scheduled = false; clearTimeout(timer)
    timer = setTimeout(() => { primed = true; schedule(0) }, HEAD_MS)
  }
  waiting.set(a.key, a)
  schedule(SETTLE)
}
const SETTLE = 350   // the board fit animates ~250 ms from 60 ms after mount: rank the first pick on the settled view

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
  if (ms) setTimeout(run, ms); else queueMicrotask(run)
}

function pump(): void {
  scheduled = false
  while (active.size < (primed ? SLOTS : 1) && waiting.size) {
    let best: Admission | undefined, bestRank = Infinity
    for (const a of waiting.values()) { const r = a.rank(); if (r < bestRank || !best) { best = a; bestRank = r } }
    waiting.delete(best!.key)
    active.add(best!.key)
    ;(globalThis as { __mvAdmitted?: string[] }).__mvAdmitted?.push(best!.key)   // diagnostic: the order, when a probe asks for it
    best!.start()
  }
}

/** For tests: nothing queued, nothing active. */
export function resetAdmission(): void { waiting.clear(); active.clear(); primed = false; scheduled = false; gen++; clearTimeout(timer) }
