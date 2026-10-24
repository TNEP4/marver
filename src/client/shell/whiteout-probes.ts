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
 * camera (`canvasCtl.transform()`) for the bracket. **The camera at every animation frame of the bracket**: from
 * `pick` to `verify` the shell records the camera once a frame (the frames a capture can have read), since a pan
 * that turns back - the recorder's own pan is 60 wheel events one way and 60 the other, and main's bracket can last
 * some 800 ms (150 + 500 + 150) - can sweep a node over a probe and back with the two ends the same (review of
 * a3-native, minor #16). `verify` maps each point through the pick's camera and each recorded one, both ways: the
 * world point under it at pick, drawn at that frame, and the world point under it at that frame, drawn as the camera
 * was at pick. The second is the one that matters under a zoom - if the world point under the probe at a frame was,
 * at the pick's camera, closer than the clearance, no node (each at least the clearance away then) covered it at that
 * frame; under a zoom out a node's edge moves further than the probe's own world point, so the first alone does not
 * say that. A point is valid when every frame's moves are under its clearance, it is still `VERIFY_MARGIN` (8 px)
 * clear of every node now, and the surface is still under it. With no camera (no canvas) every point is invalid: the
 * sample is inconclusive. A main thread stalled for the whole bracket records no frame between, and draws none
 * either: the camera is the shell's. Nodes that move on the board themselves (a drag, a layout animation) are not the
 * camera's and not covered by this.
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
/** At `verify`, each kept point still this far from every node's rect, px (the design's margin). */
export const VERIFY_MARGIN = 8

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

/** The points a tick picked, its clearances, its camera and the camera at each frame since, for its `verify` (the last four ticks kept). */
const kept = new Map<number, { pts: [number, number][]; clear: number[]; cam: PerfCam | null; path: PerfCam[]; stop(): void }>()
/** The longest bracket recorded, in frames (5 s at 120 Hz): past it a verify finds the path cut, and says invalid. */
export const PATH_FRAMES = 600

/** The camera at each animation frame from now until `stop()`, or until it holds PATH_FRAMES (then the path is cut). */
function cameraPath(): { path: PerfCam[]; stop(): void } {
  const path: PerfCam[] = []
  let on = true
  const step = () => {
    if (!on) return
    const c = canvasCtl.transform()
    if (c) path.push({ ...c })
    if (path.length >= PATH_FRAMES) { on = false; return }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  return { path, stop: () => { on = false } }
}

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
  const run = cameraPath()
  kept.get(tick)?.stop()
  kept.set(tick, { pts: chosen.map((x) => x.p), clear: chosen.map((x) => Math.min(x.c, 1e6)), cam, path: run.path, stop: run.stop })
  for (const k of [...kept.keys()]) if (kept.size > 4 && k !== tick) { kept.get(k)!.stop(); kept.delete(k) }
  return { kind: 'probes', tick, at: 'before', points: chosen.map((x) => x.p), cam, view: view() }
}

/** The `after` answer for `tick`: one flag per point `pick(tick)` gave. */
export function verify(tick: number): Extract<PerfMsg, { kind: 'probes'; at: 'after' }> {
  const k = kept.get(tick)
  const cam = canvasCtl.transform()
  if (!k) return { kind: 'probes', tick, at: 'after', valid: [], cam, view: view() }
  kept.delete(tick)
  const cut = k.path.length >= PATH_FRAMES
  k.stop()
  const rects = nodeRects()
  const o = origin()
  // every camera the bracket's frames showed, and the one now
  const cams = cam ? [...k.path, cam] : []
  const valid = k.pts.map(([x, y], i) => {
    if (!k.cam || !cam || cut) return false
    const c = k.clear[i]!
    for (const at of cams) if (moved(x, y, k.cam, at, o) >= c || moved(x, y, at, k.cam, o) >= c) return false
    if (clearance(x, y, rects) < VERIFY_MARGIN) return false
    return isSurface(document.elementFromPoint(x, y))
  })
  return { kind: 'probes', tick, at: 'after', valid, cam, view: view() }
}
