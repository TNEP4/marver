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
 * FROZEN signatures (A3.8 #53). The geometry: a 12 x 8 grid of cell centres over the usable rectangle, below the
 * scroll edge; a point's clearance is its distance to the nearest node's rect (`getBoundingClientRect`: transforms and
 * animation included); the 16 with the most clearance that have the canvas surface under them are kept, with the
 * camera (`canvasCtl.transform()`) for the bracket. `verify` maps each point through the two cameras - the world
 * point under it, where it is drawn now - and a point is valid when that move is less than its clearance (no node
 * can have reached it), no node covers it now, and the surface is still under it. With no camera (no canvas) every
 * point is invalid: the sample is inconclusive.
 */
import { PERF_BOUNDS, type PerfCam, type PerfMsg } from '../../shared/app-api.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { VISIBLE_TOP } from './inset.ts'

/** At most this many probes a tick (the bridge refuses more than PERF_BOUNDS.points). */
export const MAX_PROBES = Math.min(16, PERF_BOUNDS.points)
/** Each probe's clearance from every node's screen rect, px. */
export const PROBE_CLEARANCE = 48
/** The candidate grid over the usable rectangle. */
export const PROBE_GRID: readonly [number, number] = [12, 8]

const view = () => ({ w: innerWidth, h: innerHeight })
type Rect = { left: number; top: number; right: number; bottom: number }

/** The canvas surface itself: the zoom wrapper, its content or the world - never a frame, a caption, the chrome. */
export function isSurface(el: Element | null): boolean {
  if (!el) return false
  return el.id === 'sh-world' || el.classList.contains('sh-canvas') || el.classList.contains('sh-content')
}

/** A point's distance to the nearest rect (0 inside one); Infinity with none. */
export function clearance(x: number, y: number, rects: readonly Rect[]): number {
  let d = Infinity
  for (const r of rects) {
    const dx = Math.max(r.left - x, 0, x - r.right)
    const dy = Math.max(r.top - y, 0, y - r.bottom)
    d = Math.min(d, Math.hypot(dx, dy))
    if (d === 0) return 0
  }
  return d
}

/** Where the world point under (x, y) at camera a is drawn at camera b, `o` the canvas wrapper's client origin. */
export function moved(x: number, y: number, a: PerfCam, b: PerfCam, o: { x: number; y: number }): number {
  const wx = (x - o.x - a.x) / a.s
  const wy = (y - o.y - a.y) / a.s
  return Math.hypot(o.x + b.x + wx * b.s - x, o.y + b.y + wy * b.s - y)
}

const nodeRects = (): Rect[] => [...document.querySelectorAll('.sh-node')].map((e) => e.getBoundingClientRect())
const origin = () => { const r = document.querySelector('.sh-canvas')?.getBoundingClientRect(); return { x: r?.left ?? 0, y: r?.top ?? 0 } }

/** The points a tick picked, its clearances and its camera, for its `verify` (the last four ticks kept). */
const kept = new Map<number, { pts: [number, number][]; clear: number[]; cam: PerfCam | null }>()

/** The `before` answer for `tick`: the points chosen now, the camera and the viewport. */
export function pick(tick: number): Extract<PerfMsg, { kind: 'probes'; at: 'before' }> {
  const top = VISIBLE_TOP
  const w = innerWidth, h = Math.max(0, innerHeight - top)
  const rects = nodeRects()
  const [cols, rows] = PROBE_GRID
  const cands: { p: [number, number]; c: number }[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = Math.round((i + 0.5) * w / cols)
      const y = Math.round(top + (j + 0.5) * h / rows)
      const c = clearance(x, y, rects)
      if (c < PROBE_CLEARANCE) continue
      if (!isSurface(document.elementFromPoint(x, y))) continue
      cands.push({ p: [x, y], c })
    }
  }
  cands.sort((a, b) => b.c - a.c)
  const chosen = cands.slice(0, MAX_PROBES)
  const cam = canvasCtl.transform()
  kept.set(tick, { pts: chosen.map((x) => x.p), clear: chosen.map((x) => Math.min(x.c, 1e6)), cam })
  for (const k of [...kept.keys()]) if (kept.size > 4 && k !== tick) kept.delete(k)
  return { kind: 'probes', tick, at: 'before', points: chosen.map((x) => x.p), cam, view: view() }
}

/** The `after` answer for `tick`: one flag per point `pick(tick)` gave. */
export function verify(tick: number): Extract<PerfMsg, { kind: 'probes'; at: 'after' }> {
  const k = kept.get(tick)
  const cam = canvasCtl.transform()
  if (!k) return { kind: 'probes', tick, at: 'after', valid: [], cam, view: view() }
  kept.delete(tick)
  const rects = nodeRects()
  const o = origin()
  const valid = k.pts.map(([x, y], i) => {
    if (!k.cam || !cam) return false
    if (moved(x, y, k.cam, cam, o) >= k.clear[i]!) return false
    if (clearance(x, y, rects) === 0) return false
    return isSurface(document.elementFromPoint(x, y))
  })
  return { kind: 'probes', tick, at: 'after', valid, cam, view: view() }
}
