/**
 * The pure parts of the page's signals (spec 30 R5, R6), kept apart from the browser-coupled module so they can be
 * unit-tested (recorder-core.ts's precedent): a request's route without its names, a gesture's three longest Long
 * Animation Frames and what they ran, a minute's heaviest re-render rows and warning nodes, a source's rate, the
 * nodes a view shows. No imports but types and constants.
 */
import { LOAF, RENDERS, WARNINGS, type Loaf, type RenderRow } from '../../shared/perf-records.ts'

// ---- #31: a request's route -----------------------------------------------------------------------------------------

/** The routes the dev server answers whose every segment is a fixed word: said as they are. */
const FIXED = new Set([
  'policy', 'boards', 'boards/status', 'boards/pin', 'boards/rename', 'boards/reorder', 'boards.rights', 'scenes/rename',
  'sizes', 'folders', 'membership', 'shot', 'shots', 'anchor', 'bakes', 'poster', 'me', 'profile', 'marks', 'marks/seen',
  'work', 'seen', 'update', 'sync', 'request-access', 'invite-info', 'auth/signin', 'auth/claim', 'hello',
  'jam/queue', 'jam/card', 'jam/audio-ticket', 'jam/voice', 'jam/session', 'jam/run', 'jam/prefs', 'jam/capture-open',
  'jam/record', 'jam/capture', 'jam/picture', 'jam/picture/live',
])
/** Everything after the first segment that is not a fixed word is a name or an id. */
const WORD = /^[a-z][a-z-]*$/
/**
 * #31: a request's route, ids and names replaced (`boards/:board`), never a query. Under the API: its path after
 * `/api/`, a known route as it is, `boards/<x>` and `comments/<x>` by what `<x>` is, anything else its first word and
 * `:id` for the rest. Elsewhere: the first segment, the rest `:path` - `design/manifest.json` is the one fixed name.
 */
export function normRoute(url: string): string {
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0]
  const api = /(?:^|\/)api\/(.*)$/.exec(path)
  if (api) {
    const rel = api[1].replace(/\/+$/, '')
    if (FIXED.has(rel)) return rel
    const segs = rel.split('/')
    if (segs[0] === 'boards' && segs.length === 2) return 'boards/:board'
    if (segs[0] === 'comments' && segs.length === 2) return 'comments/:board'
    return segs.map((s, i) => (i === 0 && WORD.test(s) ? s : ':id')).join('/')
  }
  const rel = path.replace(/^\/+/, '')
  if (rel === 'design/manifest.json') return rel
  const segs = rel.split('/').filter(Boolean)
  return segs.length ? `${WORD.test(segs[0]) ? segs[0] : ':path'}${segs.length > 1 ? '/:path' : ''}` : '/'
}

// ---- #35: a gesture's Long Animation Frames ----------------------------------------------------------------------

/** What this module reads of a `PerformanceScriptTiming`. */
export interface LoafScript { duration: number; sourceURL?: string; sourceFunctionName?: string; invoker?: string; windowAttribution?: string; window?: unknown }
/** What this module reads of a `long-animation-frame` entry; a `longtask` entry (Safari, Firefox) has `duration` alone. */
export interface LoafEntry { startTime?: number; duration: number; blockingDuration?: number; scripts?: readonly LoafScript[] }

/** A URL's path, no query, no host; '' when it is not one. */
export function urlPath(raw: string | undefined): string {
  if (!raw) return ''
  try { return new URL(raw, 'http://x').pathname } catch { return '' }
}
/** Keep the `kept` longest as they arrive (a heavy gesture has many, and an entry holds its scripts' windows). */
export function keepLongest(top: LoafEntry[], e: LoafEntry, kept: number = LOAF.kept): void {
  top.push(e)
  top.sort((a, b) => b.duration - a.duration)
  if (top.length > kept) top.length = kept
}
/**
 * #35: the longest frames, longest first: `ms`, `blockMs`, and the longest script's `src` (a URL path, no query),
 * `frame` (what `frameOf` makes of its path and its window: a frame's module path names the frame), `fn` (64
 * characters), `invoker` (no query, 64 characters), `ms` and `where` (`windowAttribution`). A `longtask` entry: `ms` alone.
 */
export function pickLoafs(entries: readonly LoafEntry[], frameOf: (src: string, win: unknown) => string | undefined, kept: number = LOAF.kept): Loaf[] {
  return [...entries].sort((a, b) => b.duration - a.duration).slice(0, kept).map((e) => {
    const out: Loaf = { ms: Math.round(e.duration) }
    if (typeof e.blockingDuration === 'number') out.blockMs = Math.round(e.blockingDuration)
    const s = e.scripts?.length ? e.scripts.reduce((a, b) => (b.duration > a.duration ? b : a)) : undefined
    if (s) {
      const src = urlPath(s.sourceURL)
      const frame = frameOf(src, s.window)
      out.script = {
        ms: Math.round(s.duration),
        ...(src ? { src } : {}),
        ...(frame ? { frame } : {}),
        ...(s.sourceFunctionName ? { fn: s.sourceFunctionName.slice(0, LOAF.fn) } : {}),
        ...(s.invoker ? { invoker: s.invoker.replace(/[?#].*$/, '').slice(0, LOAF.fn) } : {}),
        ...(s.windowAttribution ? { where: s.windowAttribution } : {}),
      }
    }
    return out
  })
}

// ---- #36, #28: a minute's rows -------------------------------------------------------------------------------------

/** One minute's accumulating row (`who`, `frame`). */
export function addRow(rows: Map<string, RenderRow>, who: string, frame: string | undefined, r: { commits: number; ms: number; maxMs: number; inGesture: number }): void {
  const cur = rows.get(who)
  if (!cur) { rows.set(who, { who, ...(frame ? { frame } : {}), commits: r.commits, ms: r.ms, maxMs: r.maxMs, inGesture: r.inGesture }); return }
  cur.commits += r.commits; cur.ms += r.ms; cur.inGesture += r.inGesture
  if (r.maxMs > cur.maxMs) cur.maxMs = r.maxMs
  if (frame) cur.frame = frame
}
/** #36: the `max` heaviest rows by `ms`, the rest folded into one `others` row that says how many it holds. */
export function foldRows(rows: Iterable<RenderRow>, max: number = RENDERS.rows): RenderRow[] {
  const tenth = (x: number) => Math.round(x * 10) / 10
  const all = [...rows].sort((a, b) => b.ms - a.ms).map((r) => ({ ...r, ms: tenth(r.ms), maxMs: tenth(r.maxMs) }))
  if (all.length <= max) return all
  const rest = all.slice(max)
  const others: RenderRow = { who: 'others', commits: 0, ms: 0, maxMs: 0, inGesture: 0, rows: rest.length }
  for (const r of rest) { others.commits += r.commits; others.ms += r.ms; others.inGesture += r.inGesture; if (r.maxMs > others.maxMs) others.maxMs = r.maxMs }
  others.ms = tenth(others.ms)
  return [...all.slice(0, max), others]
}
/** #28: the minute's total, and the `top` nodes with most. */
export function topWarnings(by: ReadonlyMap<string, number>, top: number = WARNINGS.top): { n: number; top: { node: string; n: number }[] } {
  let n = 0
  for (const c of by.values()) n += c
  return { n, top: [...by].sort((a, b) => b[1] - a[1]).slice(0, top).map(([node, c]) => ({ node, n: c })) }
}

// ---- rates, percentiles, what a view shows --------------------------------------------------------------------------

/** At most `perSecond` in each wall second (the rule the frames' budget keeps). */
export function createRate(perSecond: number, now: () => number = () => performance.now()): () => boolean {
  let sec = NaN, inSec = 0
  return () => {
    const s = Math.floor(now() / 1000)
    if (s !== sec) { sec = s; inSec = 0 }
    if (inSec >= perSecond) return false
    inSec++
    return true
  }
}
/** The nearest-rank median of `xs` (cli/perf.ts `spread`'s rule), undefined with none. */
export function p50(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined
  const v = [...xs].sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.ceil(0.5 * v.length) - 1)]
}
/** A node's title bar is part of its box (FrameNode). */
const HEADER = 28
/** recorder.ts `cohortIn`: the nodes a view shows. */
export function nodesIn<N extends { key: string; x: number; y: number; w: number; h: number }>(nodes: readonly N[], v: { x: number; y: number; w: number; h: number }): N[] {
  return nodes.filter((n) => n.x < v.x + v.w && n.x + n.w > v.x && n.y < v.y + v.h && n.y + n.h + HEADER > v.y)
}
