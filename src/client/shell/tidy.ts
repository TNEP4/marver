export interface TidyNode { key: string; frame: string; scene: string; group?: string; variant?: string; w: number; h: number }
export interface Placed { key: string; x: number; y: number }

// SPEC-024 lane-flow grammar: one shape at both scopes. A scope is rows XOR columns
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

// Adaptive units (SPEC-024 §2): a "block" is a multiple of the proportional gutter,
// measured from the touching content's characteristic size - never a fixed pixel count.
const frameGapX = (w: number) => Math.max(140, w * 0.12)
const frameGapY = (h: number) => Math.max(96, h * 0.16)
const sceneGapX = (w: number) => Math.max(280, w * 0.2)
const sceneGapY = (h: number) => Math.max(96, h * 0.16)

/** An atom resolved to concrete content: member nodes at relative offsets + extents.
 *  charW/charH drive gap units (max FRAME size, not box size - a wide scene box must
 *  not inflate its neighbors' gutters). */
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

/** The one flow engine (both scopes, both axes). Places boxes; returns absolute
 *  box origins. Lanes share an origin on the cross axis - that IS the alignment. */
function layoutFlow(
  flow: Required<Pick<Flow, never>> & Flow,
  resolve: (atom: string) => Box | null,
  unresolved: Box[],                 // appended after the recipe (trailing lanes / final lane)
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

  let cross = 0                      // rows: y of current lane · columns: x of current lane
  let pendingLane = 0                // units before the NEXT lane (0 = ordinary)
  let prevLaneChar = 0
  let laneCount = 0

  const lanes: Array<{ atoms: Array<Box | number> }> = []  // number = spacer units within lane
  for (const entry of entries) {
    if (isSpace(entry)) {
      if (pendingLane) warn('consecutive lane spacers - using the last one')
      pendingLane = units(entry, warn)
      continue
    }
    if (!Array.isArray(entry)) continue
    const atoms: Array<Box | number> = []
    for (const a of entry) {
      if (isSpace(a)) { atoms.push(units(a, warn)); continue }
      if (typeof a !== 'string') continue
      if (seen.has(a)) { warn(`"${a}" listed twice - first occurrence wins`); continue }
      const b = resolve(a)
      if (!b) { warn(`unknown "${a}" in layout - skipped`); continue }
      seen.add(a)
      atoms.push(b)
    }
    lanes.push({ atoms })
    // spacer units recorded on the lane boundary BEFORE this lane
    ;(lanes[lanes.length - 1] as any).beforeUnits = laneCount === 0 ? 0 : Math.max(1, pendingLane || 1)
    if (laneCount === 0 && pendingLane) warn('leading lane spacer ignored')
    pendingLane = 0
    laneCount++
  }
  if (pendingLane) warn('trailing lane spacer ignored')
  // unresolved content: board scope appends trailing one-atom lanes; scene scope appends
  // to the final lane (codex-reviewed rule - keeps the recipe the single source of order)
  if (unresolved.length) {
    if (lanes.length) lanes[lanes.length - 1].atoms.push(...unresolved)
    else lanes.push(Object.assign({ atoms: [...unresolved] as Array<Box | number> }, { beforeUnits: 0 }) as any)
  }

  for (const lane of lanes) {
    const before = (lane as any).beforeUnits ?? 0
    if (before) cross += (gapCross(prevLaneChar) * (before - 1))  // ordinary gap added below with lane extent
    let main = 0
    let laneExtent = 0
    let laneChar = 0
    let pending = 0
    let prevChar = 0
    let placedAny = false
    for (const a of lane.atoms) {
      if (typeof a === 'number') {
        if (!placedAny) { warn('leading spacer in lane ignored'); continue }
        if (pending) warn('consecutive spacers - using the last one')
        pending = a
        continue
      }
      if (placedAny) {
        const n = Math.max(1, pending || 1)
        main += gapMain(Math.max(prevChar, vertical ? a.charH : a.charW)) * n
      }
      pending = 0
      const x = vertical ? cross : main
      const y = vertical ? main : cross
      out.set(a.id, { x, y })
      main += vertical ? a.h : a.w
      laneExtent = Math.max(laneExtent, vertical ? a.w : a.h)
      laneChar = Math.max(laneChar, vertical ? a.charW : a.charH)
      prevChar = vertical ? a.charH : a.charW
      placedAny = true
    }
    if (pending) warn('trailing spacer in lane ignored')
    cross += laneExtent + gapCross(laneChar || prevLaneChar || 1)
    prevLaneChar = laneChar || prevLaneChar
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

const rel = (id: string, scene: string) => (id.startsWith(scene + '/') ? id.slice(scene.length + 1) : id)

/** Lay out ONE scene: recipe if present, else a single default lane. Returns member
 *  positions relative to the scene origin. */
function layoutScene(scene: string, members: TidyNode[], flow: Flow | undefined, warn: Warn): Map<string, { x: number; y: number }> {
  // resolve an atom to a Box: frame basename first (more specific), then group run
  const resolve = (atom: string): Box | null => {
    const frames = members.filter((n) => rel(n.frame, scene) === atom)
    if (frames.length) {
      // all node instances of the frame, side by side (duplicates are rare but legal)
      const parts: Array<{ key: string; dx: number; dy: number; w: number; h: number }> = []
      let dx = 0
      for (const n of frames) { parts.push({ key: n.key, dx, dy: 0, w: n.w, h: n.h }); dx += n.w + frameGapX(n.w) }
      return box(atom, parts)
    }
    const run = members.filter((n) => n.group && rel(n.group, scene) === atom)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
    if (run.length) {
      // a variant run always expands horizontally and is indivisible (SPEC-024 §1)
      const parts: Array<{ key: string; dx: number; dy: number; w: number; h: number }> = []
      let dx = 0
      for (const n of run) { parts.push({ key: n.key, dx, dy: 0, w: n.w, h: n.h }); dx += n.w + frameGapX(n.w) }
      return box(atom, parts)
    }
    return null
  }

  let flows: Flow
  if (flow && (flow.rows || flow.columns)) {
    if (flow.rows && flow.columns) { warn(`scene "${scene}": rows AND columns - using rows`); flows = { rows: flow.rows } }
    else flows = flow
  } else {
    // default: one lane, node order, group runs contiguous (dedupe: duplicate node
    // instances share one atom - resolve() expands every instance)
    flows = { rows: [[...new Set(orderWithinScene(members).map((n) => rel(n.frame, scene)))]] }
  }
  // unlisted frames (recipe'd scenes only): append to the final lane, node order.
  // A frame is "listed" if its own basename OR its group's name appears.
  const leftovers: Box[] = []
  const covered = new Set<string>()
  for (const entry of [...(flows.rows ?? []), ...(flows.columns ?? [])]) {
    if (!Array.isArray(entry)) continue
    for (const a of entry) {
      if (typeof a !== 'string') continue
      for (const n of members) if (rel(n.frame, scene) === a || (n.group && rel(n.group, scene) === a)) covered.add(n.key)
    }
  }
  for (const n of members) {
    if (covered.has(n.key)) continue
    covered.add(n.key)
    leftovers.push(box(rel(n.frame, scene) + '#' + n.key, [{ key: n.key, dx: 0, dy: 0, w: n.w, h: n.h }]))
  }

  const placedBoxes = layoutFlow(flows, resolve, leftovers, frameGapX, frameGapY, warn)
  // expand boxes to member positions
  const boxIndex = new Map<string, Box>()
  for (const entry of [...(flows.rows ?? []), ...(flows.columns ?? [])]) {
    if (!Array.isArray(entry)) continue
    for (const a of entry) { if (typeof a === 'string' && !boxIndex.has(a)) { const b = resolve(a); if (b) boxIndex.set(a, b) } }
  }
  for (const b of leftovers) boxIndex.set(b.id, b)
  const out = new Map<string, { x: number; y: number }>()
  for (const [id, pos] of placedBoxes) {
    const b = boxIndex.get(id)
    if (!b) continue
    for (const p of b.parts) out.set(p.key, { x: pos.x + p.dx, y: pos.y + p.dy })
  }
  return out
}

/**
 * Pure layout (spec §7 + SPEC-023 + SPEC-024). Returns positions only - the nodes
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

  // pass 2: board flow over scene boxes
  let boardFlow: Flow
  if (layout && layout.rows && layout.columns) { warn('layout has rows AND columns - using rows'); boardFlow = { rows: layout.rows } }
  else if (layout && (layout.rows || layout.columns)) boardFlow = { rows: layout.rows, columns: layout.columns }
  else boardFlow = { rows: [] }      // default: every scene its own trailing lane (alphabetical)

  const listed = new Set<string>()
  for (const entry of [...(boardFlow.rows ?? []), ...(boardFlow.columns ?? [])]) {
    if (Array.isArray(entry)) for (const a of entry) if (typeof a === 'string') listed.add(a)
  }
  const trailing = scenes.filter((s) => !listed.has(s)).sort().map((s) => sceneBoxes.get(s)!)
  // board scope: unlisted scenes become their OWN lanes, not tail atoms of the last lane
  const vertical = !!boardFlow.columns
  const entriesKey = vertical ? 'columns' : 'rows'
  const flowWithTrailing: Flow = {
    [entriesKey]: [
      ...((vertical ? boardFlow.columns : boardFlow.rows) ?? []),
      ...trailing.map((b) => [b.id] as Lane),
    ],
  }

  const placedScenes = layoutFlow(flowWithTrailing, (atom) => sceneBoxes.get(atom) ?? null, [], sceneGapX, sceneGapY, warn)

  const out: Placed[] = []
  for (const [scene, pos] of placedScenes) {
    const m = sceneMaps.get(scene)
    if (!m) continue
    for (const [key, p] of m) out.push({ key, x: pos.x + p.x, y: pos.y + p.y })
  }
  return out
}
