/**
 * The capture matrix's judging, pure (spec 28 A3.8 #34-#37; review of a3-native, majors #2-#4, minor #11): where each
 * sample sits, what may show there at a frame's display time, the calibration's checks, and when main decided and
 * when the state settled - read from main's journal by time, never by index.
 *
 * What may show under the tabs (one ground): before a transition's decision, what showed before it; from the
 * decision, only ground and dots (the cover); from each `present uncover` of the target, the target document's own
 * tags - its document tag anywhere, its size tag only where a view of the uncovered width draws it
 * (`innerWidth - 260`): a frame of an older width shows it elsewhere, and that frame is bad (A3.8 #34). A compose
 * that shows the cover again starts another covered stretch.
 */
import type { CaptureFrame, FrameVerdict } from '../harness/capture.ts'
import { SIZE_TAG_X } from '../harness/fake-canvas.ts'

export type Rect = { x: number; y: number; w: number; h: number }
export type Grid = readonly [number, number]

/** The window point of a region's k-th sample: capture.swift's grid, cell centres, row by row. */
export function samplePoint(r: Rect, k: number, grid: Grid): { x: number; y: number } {
  const [cols, rows] = grid
  const i = k % cols, j = Math.floor(k / cols) % rows
  return { x: r.x + (r.w * (i + 0.5)) / cols, y: r.y + (r.h * (j + 0.5)) / rows }
}

/** The fixture's tags (fake-canvas.ts ground mode), in window points with the view at x 0: where they are drawn. */
export const SIZE_TAG_W = 12
export const sizeTagRect = (width: number) => ({ x0: width - SIZE_TAG_X, x1: width - SIZE_TAG_X + SIZE_TAG_W, y0: 12, y1: 32 })
export const docTagRect = (width: number) => ({ x0: width / 2 - 30, x1: width / 2 + 30, y0: 12, y1: 32 })
/** inside a tag's rect, with a 1 pt margin for its antialiased edge */
const inside = (p: { x: number; y: number }, r: { x0: number; x1: number; y0: number; y1: number }) => p.x >= r.x0 - 1 && p.x <= r.x1 + 1 && p.y >= r.y0 - 1 && p.y <= r.y1 + 1

/** A document allowed under the tabs: its tag (hex) and the width its view was uncovered at. */
export interface Shown { tag: string; width: number }
/** From `from` on (display time, ns), what may show: a document's own tags, or nothing but ground (`null`). */
export interface Segment { from: bigint; shown: Shown | null }
export function shownAt(segs: readonly Segment[], ns: bigint): Shown | null {
  let s: Shown | null = null
  for (const g of segs) { if (g.from <= ns) s = g.shown; else break }
  return s
}

/**
 * The colour classes a sample can fall in: `ground` (the ground and its dots, as calibrated), `tag:<hex>` (a document
 * tag), `size` (the size tag), `band` (a ground-mode document's own top band: its pixel, allowed only where its
 * document is), anything else `other`.
 */
export type Classify = (hex: string) => 'ground' | 'size' | 'band' | 'other' | `tag:${string}`

/**
 * One frame against what may show at its display time (`shown`): every sample of every judged region read. `unread`
 * when a judged region is not in the frame, or none of its samples was read (all outside the window): a frame that
 * carries nothing of what the case reads is never good (review of a3-native, minor #10). A single sample outside a
 * window resized smaller reads nothing and says nothing.
 */
export function frameVerdict(f: CaptureFrame, o: { regions: Record<string, Rect>; grid: Grid; classify: Classify; shown: Shown | null }): FrameVerdict {
  for (const name of Object.keys(o.regions)) if (!(f.regions?.[name] ?? []).some(Boolean)) return 'unread'
  for (const [name, samples] of Object.entries(f.regions ?? {})) {
    const r = o.regions[name]
    if (!r) continue
    for (const [k, hex] of samples.entries()) {
      if (!hex) continue   // outside a window resized smaller: reads nothing, says nothing
      const c = o.classify(hex)
      if (c === 'ground') continue
      const s = o.shown
      if (!s) return 'bad'
      if (c === 'band' || c === `tag:${s.tag}`) continue
      if (c === 'size' && inside(samplePoint(r, k, o.grid), sizeTagRect(s.width))) continue
      return 'bad'
    }
  }
  return 'good'
}

/** Two calibrated colours of different classes within `tolerance` of each other: the run cannot tell them apart. */
export function clash(named: readonly { name: string; hex: string }[], tolerance: number): string | null {
  const rgb = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i]!, b = named[j]!
      if (a.name === b.name) continue
      const d = Math.max(...rgb(a.hex).map((v, k) => Math.abs(v - rgb(b.hex)[k]!)))
      if (d <= tolerance) return `${a.name} (${a.hex}) and ${b.name} (${b.hex}) are ${d} apart, within the tolerance ${tolerance}`
    }
  }
  return null
}

/** The most common sample: a region's colour, read past its antialiased edges. */
export function mode(samples: readonly string[]): string | null {
  const n = new Map<string, number>()
  for (const s of samples) if (s) n.set(s, (n.get(s) ?? 0) + 1)
  let best: string | null = null, k = 0
  for (const [s, c] of n) if (c > k) { best = s; k = c }
  return best
}

// ---- main's journal --------------------------------------------------------------------------------------------

export interface LogLine { topic: string; seq?: number; t: string; data: Record<string, unknown> }
const T = (l: LogLine) => BigInt(l.t)
const compose = (l: LogLine) => l.topic === 'compose'
const uncoverOf = (tab: string) => (l: LogLine) => l.topic === 'present' && l.data.op === 'uncover' && l.data.tab === tab

/** Main's decision: the first compose at or after `before` that makes `target` the active tab. */
export function decisionOf(lines: readonly LogLine[], before: bigint, target: string): bigint | null {
  const c = lines.find((l) => compose(l) && T(l) >= before && l.data.active === target)
  return c ? T(c) : null
}

/**
 * The state after a decision has settled: no compose for `quietNs`, the target active in the last one, and for a
 * see-through target its last compose leaves the cover off after an uncover. Then the window's segments: covered
 * from the decision, the target's document from each uncover (at the width of the compose before it), covered again
 * from each compose that shows the cover. `tagAt(t)` names the document main uncovered (the fixture's latest load
 * for that tab, or null when none qualifies: a reload that loaded nothing new). null while not settled.
 */
export function settleOf(lines: readonly LogLine[], o: {
  t0: bigint; target: string; seeThrough: boolean; now: bigint; quietNs: bigint
  tagAt(t: bigint): string | null
}): { at: bigint; segments: Segment[]; uncovered: boolean } | null {
  const after = lines.filter((l) => T(l) >= o.t0).sort((a, b) => (T(a) < T(b) ? -1 : T(a) > T(b) ? 1 : 0))
  const composes = after.filter(compose)
  const last = composes.at(-1)
  if (!last || last.data.active !== o.target || o.now - T(last) < o.quietNs) return null
  const segments: Segment[] = [{ from: o.t0, shown: null }]
  let width = Number(last.data.w)
  let uncovered = false
  let at = T(last)
  for (const l of after) {
    if (compose(l)) {
      width = Number(l.data.w)
      if ((l.data.cover as { visible?: boolean } | undefined)?.visible) { if (segments.at(-1)!.shown) segments.push({ from: T(l), shown: null }); uncovered = false }
    } else if (uncoverOf(o.target)(l)) {
      // the document main uncovered; none that qualifies (no new load after a reload) allows nothing but ground, so
      // whatever that document shows is a bad frame - judged, not left unsettled
      const tag = o.tagAt(T(l))
      segments.push({ from: T(l), shown: tag ? { tag, width } : null })
      uncovered = true
      if (T(l) > at) at = T(l)
    }
  }
  if (o.seeThrough && !uncovered) return null
  return { at, segments, uncovered }
}
