/**
 * The white-out detector's probes, the shell's half (spec 28 A3.3, A3.8 #16): up to 16 points of empty canvas
 * background, picked geometrically before main captures and checked again after. Owner: the flash stream.
 *
 * During a gesture frames take no pointer events (styles.css ~169), so hit-testing alone would take a white frame
 * for ground: `pick(tick)` takes grid points inside `usable()` below `VISIBLE_TOP` (inset.ts), each at least 48 px
 * from every `.sh-node`'s screen rect, with the canvas surface under it; `verify(tick)` says which are still valid -
 * moved on screen by less than their clearance between the two answers. A frame white on purpose is excluded by its
 * rect. Main treats fewer than 4 valid probes, a changed document, bounds or active tab, or an answer later than
 * 150 ms as inconclusive, never white.
 *
 * FROZEN signatures (A3.8 #53). Until the flash stream fills them they answer no points: every sample inconclusive.
 */
import { PERF_BOUNDS, type PerfMsg } from '../../shared/app-api.ts'

/** At most this many probes a tick (the bridge refuses more than PERF_BOUNDS.points). */
export const MAX_PROBES = Math.min(16, PERF_BOUNDS.points)
/** Each probe's clearance from every node's screen rect, px. */
export const PROBE_CLEARANCE = 48

const view = () => ({ w: innerWidth, h: innerHeight })

/** The `before` answer for `tick`: the points chosen now, the camera and the viewport. */
export function pick(tick: number): Extract<PerfMsg, { kind: 'probes'; at: 'before' }> {
  return { kind: 'probes', tick, at: 'before', points: [], cam: null, view: view() }
}

/** The `after` answer for `tick`: one flag per point `pick(tick)` gave. */
export function verify(tick: number): Extract<PerfMsg, { kind: 'probes'; at: 'after' }> {
  return { kind: 'probes', tick, at: 'after', valid: [], cam: null, view: view() }
}
