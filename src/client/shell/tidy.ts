export interface TidyNode { key: string; frame: string; scene: string; group?: string; variant?: string; w: number; h: number }
export interface Placed { key: string; x: number; y: number }

// Lane-flow grammar: one shape at both scopes. A scope is rows XOR columns
// of lanes; a lane is atoms + {space:n} tokens. Board atoms are scene names; a scene
// recipe's atoms are frame basenames or a variant-group name (one indivisible run).
export interface Space { space: number }
export type Lane = Array<string | Space>
export interface Flow { rows?: Array<Lane | Space>; columns?: Array<Lane | Space> }
export interface BoardLayout extends Flow { scenes?: Record<string, Flow> }
export type Warn = (msg: string) => void

const isSpace = (x: unknown): x is Space => !!x && typeof x === 'object' && !Array.isArray(x)
const units = (s: Space, warn: Warn): number =>
  Number.isInteger(s.space) && s.space > 0 ? s.space : (warn(`invalid space ${JSON.stringify(s.space)} - using 1`), 1)

// Adaptive units: a "block" is a multiple of the proportional gutter,
// measured from the touching content's characteristic FRAME size (its largest single
// frame) - a wide multi-frame box must not inflate its neighbors' gutters.
const frameGapX = (w: number) => Math.max(140, w * 0.12)
const frameGapY = (h: number) => Math.max(96, h * 0.16)
const sceneGapX = (w: number) => Math.max(280, w * 0.2)
const sceneGapY = (h: number) => Math.max(96, h * 0.16)

/** An atom resolved to concrete content: member nodes at relative offsets + extents. */
interface Box {
  id: string
  parts: Array<{ key: string; dx: number; dy: number }>
  w: number; h: number
  charW: number; charH: number
}

const box = (id: string, parts: Array<{ key: string; dx: number; dy: number; w: number; h: number }>): Box => ({
  id,
  parts: parts.map(({ key, dx, dy }) => ({ key, dx, dy })),
  w: Math.max(0, ...parts.map((p) => p.dx + p.w)),
  h: Math.max(0, ...parts.map((p) => p.dy + p.h)),
  charW: Math.max(0, ...parts.map((p) => p.w)),
  charH: Math.max(0, ...parts.map((p) => p.h)),
})

/** A run of nodes laid side by side (a frame's instances, or a variant run). */
const runBox = (id: string, run: TidyNode[]): Box => {
  const parts: Array<{ key: string; dx: number; dy: number; w: number; h: number }> = []
  let dx = 0
  for (const n of run) { parts.push({ key: n.key, dx, dy: 0, w: n.w, h: n.h }); dx += n.w + frameGapX(n.w) }
  return box(id, parts)
}

/**
 * The one flow engine (both scopes, both axes). Places boxes; returns absolute box
 * origins. Lanes share an origin on the cross axis - that IS the alignment.
 * Two phases: COLLECT lanes (resolving atoms, so skipped content never strands a
 * track), then PLACE knowing both neighbors of every boundary.
 */
function layoutFlow(
  flow: Flow,
  resolve: (atom: string) => Box | null,
  trailing: () => Box[],             // unlisted content, appended after the recipe (evaluated post-collection)
  trailingMode: 'lanes' | 'append',  // board scope: own trailing lanes · scene scope: tail of the final lane
  gapX: (c: number) => number,
  gapY: (c: number) => number,
  warn: Warn,
): Map<string, { x: number; y: number }> {
  const vertical = !!flow.columns    // columns: lanes advance in X, atoms flow in Y
  // the gap belongs to the AXIS, not the argument slot: a columns lane flows in Y,
  // so its in-lane gaps are vertical units and its lane boundaries horizontal ones
  const gapMain = vertical ? gapY : gapX
  const gapCross = vertical ? gapX : gapY
  const entries = (vertical ? flow.columns : flow.rows) ?? []
  const out = new Map<string, { x: number; y: number }>()
  const seen = new Set<string>()

  // ---- phase 1: collect ----
  interface CollectedLane { beforeUnits: number; items: Array<Box | number> }  // number = spacer units
  const lanes: CollectedLane[] = []
  let pendingLane = 0                // 0 = ordinary boundary · -1 = degraded (consecutive/invalid)
  for (const entry of entries) {
    if (isSpace(entry)) {
      if (pendingLane) { warn('consecutive lane spacers - degrading to one ordinary gap'); pendingLane = -1 }
      else pendingLane = units(entry, warn)
      continue
    }
    if (!Array.isArray(entry)) continue
    const items: Array<Box | number> = []
    let pending = 0
    let hasBox = false
    for (const a of entry) {
      if (isSpace(a)) {
        if (!hasBox) { warn('leading spacer in lane ignored'); continue }
        if (pending) { warn('consecutive spacers - degrading to one ordinary gap'); pending = -1; items[items.length - 1] = -1 }
        else { pending = units(a, warn); items.push(pending) }
        continue
      }
      if (typeof a !== 'string') { warn(`ignoring non-string atom ${JSON.stringify(a)}`); continue }
      if (seen.has(a)) { warn(`"${a}" listed twice - first occurrence wins`); continue }
      const b = resolve(a)
      if (!b) continue                               // resolve() warned with specifics
      seen.add(a)
      items.push(b)
      hasBox = true
      pending = 0
    }
    if (pending) { warn('trailing spacer in lane ignored'); items.pop() }
    if (!hasBox) {
      // a lane whose every atom was skipped (or an empty array) must not consume a
      // track - P1: `[["ghost"],["a"]]` places a at the origin, not one gap down
      if (entry.length) warn('lane with no placeable content dropped')
      continue                                       // pendingLane stays armed for the next real lane
    }
    if (lanes.length === 0 && pendingLane) warn('leading lane spacer ignored')
    lanes.push({ beforeUnits: lanes.length === 0 ? 0 : (pendingLane === -1 ? 1 : Math.max(1, pendingLane || 1)), items })
    pendingLane = 0
  }
  if (pendingLane) warn('trailing lane spacer ignored')
  const extra = trailing()
  if (extra.length) {
    if (trailingMode === 'append') {
      // scene scope: leftovers extend the FINAL lane (one shared row even when
      // every authored lane was dropped - they must not scatter into lanes)
      if (lanes.length) lanes[lanes.length - 1].items.push(...extra)
      else lanes.push({ beforeUnits: 0, items: [...extra] })
    }
    else for (const b of extra) lanes.push({ beforeUnits: lanes.length === 0 ? 0 : 1, items: [b] })
  }

  // ---- phase 2: place ----
  const laneChar = (l: CollectedLane) =>
    Math.max(0, ...l.items.filter((i): i is Box => typeof i !== 'number').map((b) => (vertical ? b.charW : b.charH)))
  const laneExtent = (l: CollectedLane) =>
    Math.max(0, ...l.items.filter((i): i is Box => typeof i !== 'number').map((b) => (vertical ? b.w : b.h)))

  let cross = 0
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    if (i > 0) {
      // the boundary sees BOTH lanes (P1: a small lane before a monitor lane must
      // not produce a phone-sized gap)
      const c = Math.max(laneChar(lanes[i - 1]), laneChar(lane), 1)
      cross += laneExtent(lanes[i - 1]) + gapCross(c) * lane.beforeUnits
    }
    let main = 0
    let pendingUnits = 0
    let prevChar = 0
    let placedAny = false
    for (const item of lane.items) {
      if (typeof item === 'number') { pendingUnits = item; continue }
      if (placedAny) {
        const n = pendingUnits === -1 ? 1 : Math.max(1, pendingUnits || 1)
        main += gapMain(Math.max(prevChar, vertical ? item.charH : item.charW)) * n
      }
      pendingUnits = 0
      out.set(item.id, { x: vertical ? cross : main, y: vertical ? main : cross })
      main += vertical ? item.h : item.w
      prevChar = vertical ? item.charH : item.charW
      placedAny = true
    }
  }
  return out
}

/** Scene placement order for the DEFAULT (recipe-less) flow: appearance order, but a
 *  variant group is one contiguous run (sorted by variant key) at its first member's slot. */
function orderWithinScene(members: TidyNode[]): TidyNode[] {
  const consumed = new Set<string>()
  const ordered: TidyNode[] = []
  for (const n of members) {
    if (consumed.has(n.key)) continue
    if (!n.group) { ordered.push(n); continue }
    const run = members.filter((m) => m.group === n.group)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
    for (const m of run) { ordered.push(m); consumed.add(m.key) }
  }
  return ordered
}

/** Group leftover nodes into placement boxes: node order, variant runs contiguous
 *  and indivisible (P1: leftovers must honor the same contract as listed content). */
function leftoverBoxes(remaining: TidyNode[]): Box[] {
  const out: Box[] = []
  const consumed = new Set<string>()
  for (const n of remaining) {
    if (consumed.has(n.key)) continue
    if (!n.group) { consumed.add(n.key); out.push(runBox(`${n.frame}#${n.key}`, [n])); continue }
    const run = remaining.filter((m) => m.group === n.group)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
    for (const m of run) consumed.add(m.key)
    out.push(runBox(`${n.group}#run`, run))
  }
  return out
}

const rel = (id: string, scene: string) => (id.startsWith(scene + '/') ? id.slice(scene.length + 1) : id)

/** Lay out ONE scene: recipe if present, else a single default lane. Returns member
 *  positions relative to the scene origin. */
function layoutScene(scene: string, members: TidyNode[], flow: Flow | undefined, warn: Warn): Map<string, { x: number; y: number }> {
  // atoms CONSUME nodes: a later atom that names already-placed content is a
  // duplicate reference, not a second placement (P1: ["pay", "pay/a"] must not
  // tear member a out of the run)
  const consumed = new Set<string>()
  const boxIndex = new Map<string, Box>()
  const resolve = (atom: string): Box | null => {
    const frames = members.filter((n) => rel(n.frame, scene) === atom)
    const run = members.filter((n) => n.group && rel(n.group, scene) === atom)
    if (frames.length && run.length) warn(`scene "${scene}": "${atom}" names a frame AND a variant group - the frame wins`)
    const chosen = frames.length ? frames : run.sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
    if (!chosen.length) { warn(`unknown "${atom}" in scene "${scene}" layout - skipped`); return null }
    const fresh = chosen.filter((n) => !consumed.has(n.key))
    if (!fresh.length) { warn(`"${atom}" repeats already-placed content - skipped`); return null }
    if (!frames.length && fresh.length !== chosen.length) {
      // some members were placed individually; the run can no longer be indivisible
      warn(`group "${atom}" already partially placed - skipped (remaining members append as unlisted)`)
      return null
    }
    for (const n of fresh) consumed.add(n.key)
    const b = runBox(atom, fresh)
    boxIndex.set(atom, b)
    return b
  }

  let flows: Flow
  if (flow && flow.rows && flow.columns) {
    warn(`scene "${scene}": layout has rows AND columns - using the default lane`)
    flows = { rows: [[...new Set(orderWithinScene(members).map((n) => rel(n.frame, scene)))]] }
  } else if (flow && (flow.rows || flow.columns)) {
    flows = flow
  } else {
    // default: one lane, node order, group runs contiguous (dedupe: duplicate node
    // instances share one atom - resolve() expands every instance)
    flows = { rows: [[...new Set(orderWithinScene(members).map((n) => rel(n.frame, scene)))]] }
  }

  // unlisted frames append AFTER the recipe as their own lane content, node order,
  // variant runs intact; evaluated post-collection so `consumed` is final
  const trailing = () => leftoverBoxes(members.filter((n) => !consumed.has(n.key)))

  const placedBoxes = layoutFlow(flows, resolve, () => {
    const boxes = trailing()
    for (const b of boxes) boxIndex.set(b.id, b)
    return boxes
  }, 'append', frameGapX, frameGapY, warn)

  const out = new Map<string, { x: number; y: number }>()
  for (const [id, pos] of placedBoxes) {
    const b = boxIndex.get(id)
    if (!b) continue
    for (const p of b.parts) out.set(p.key, { x: pos.x + p.dx, y: pos.y + p.dy })
  }
  return out
}

/**
 * Pure layout. Returns positions only - the nodes
 * array is never reordered (iframe law G-1). Two passes: each scene lays out its
 * frames (recipe or default lane), then the board flow places the scene boxes.
 */
export function tidy(nodes: TidyNode[], layout?: BoardLayout, warn: Warn = () => {}): Placed[] {
  const scenes = [...new Set(nodes.map((n) => n.scene))]

  // pass 1: per-scene relative layouts + bounding boxes
  const sceneMaps = new Map<string, Map<string, { x: number; y: number }>>()
  const sceneBoxes = new Map<string, Box>()
  for (const scene of scenes) {
    const members = nodes.filter((n) => n.scene === scene)
    const m = layoutScene(scene, members, layout?.scenes?.[scene], warn)
    sceneMaps.set(scene, m)
    const parts = members
      .filter((n) => m.has(n.key))
      .map((n) => ({ key: n.key, dx: m.get(n.key)!.x, dy: m.get(n.key)!.y, w: n.w, h: n.h }))
    sceneBoxes.set(scene, box(scene, parts))
  }

  // pass 2: board flow over scene boxes. rows AND columns is invalid: fall back to
  // PLAIN tidy (default trailing lanes), never a silent pick
  let boardFlow: Flow
  if (layout && layout.rows && layout.columns) { warn('layout has rows AND columns - ignoring it (plain tidy)'); boardFlow = { rows: [] } }
  else if (layout && (layout.rows || layout.columns)) boardFlow = { rows: layout.rows, columns: layout.columns }
  else boardFlow = { rows: [] }      // default: every scene its own trailing lane (alphabetical)

  const listed = new Set<string>()
  for (const entry of [...(boardFlow.rows ?? []), ...(boardFlow.columns ?? [])]) {
    if (Array.isArray(entry)) for (const a of entry) if (typeof a === 'string') listed.add(a)
  }
  // board scope: unlisted scenes become their OWN trailing lanes (below in rows mode,
  // right in columns mode), alphabetical
  const trailing = () => scenes.filter((s) => !listed.has(s)).sort().map((s) => sceneBoxes.get(s)!)

  const placedScenes = layoutFlow(
    boardFlow,
    (atom) => {
      const b = sceneBoxes.get(atom)
      if (!b) warn(`unknown scene "${atom}" in layout - skipped`)
      return b ?? null
    },
    trailing,
    'lanes',
    sceneGapX, sceneGapY, warn,
  )

  const out: Placed[] = []
  for (const [scene, pos] of placedScenes) {
    const m = sceneMaps.get(scene)
    if (!m) continue
    for (const [key, p] of m) out.push({ key, x: pos.x + p.x, y: pos.y + p.y })
  }
  return out
}

/** Guarded parse of agent-authored board.layout. Malformed pieces warn
 *  and degrade - they never blank the board, and never vanish silently. */
export function parseLayout(raw: unknown, warn: Warn): BoardLayout | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) { warn('layout must be an object - ignored'); return null }
  const o = raw as Record<string, unknown>
  const flow = parseFlow(o, warn)
  const scenes: Record<string, Flow> = {}
  if (o.scenes !== undefined) {
    if (!o.scenes || typeof o.scenes !== 'object' || Array.isArray(o.scenes)) warn('layout.scenes must be an object map - ignored')
    else {
      for (const [k, v] of Object.entries(o.scenes as Record<string, unknown>)) {
        const f = v && typeof v === 'object' && !Array.isArray(v) ? parseFlow(v as Record<string, unknown>, warn) : null
        if (f) scenes[k] = f
        else warn(`layout.scenes["${k}"] is not a rows/columns flow - ignored`)
      }
    }
  }
  if (!flow && !Object.keys(scenes).length) return null
  return { ...(flow ?? {}), ...(Object.keys(scenes).length ? { scenes } : {}) }
}

function parseFlow(o: Record<string, unknown>, warn: Warn): Flow | null {
  const parseEntries = (v: unknown): Array<Lane | Space> | null => {
    if (!Array.isArray(v)) { if (v !== undefined) warn('layout rows/columns must be an array - ignored'); return null }
    const out: Array<Lane | Space> = []
    for (const e of v) {
      if (Array.isArray(e)) {
        // pass atoms through loosely - the ENGINE warns with placement specifics -
        // but never SILENTLY strip junk (a dropped atom must be visible)
        out.push(e.filter((a: unknown): a is string | Space => {
          const ok = typeof a === 'string' || (!!a && typeof a === 'object' && !Array.isArray(a))
          if (!ok) warn(`ignoring invalid layout atom ${JSON.stringify(a)}`)
          return ok
        }))
      } else if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e as Space)
      else warn(`ignoring invalid layout entry ${JSON.stringify(e)}`)
    }
    return out                                   // an EMPTY array is still a layout
  }
  const rows = parseEntries(o.rows)
  const columns = parseEntries(o.columns)
  if (!rows && !columns) return null
  return { ...(rows ? { rows } : {}), ...(columns ? { columns } : {}) }
}
