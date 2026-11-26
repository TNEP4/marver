/**
 * The merge rules (spec 38, review decisions 2-6, 11). Pure functions over element maps: no fs, no clock unless given.
 *
 * - The person's save: every element they changed lands, at a version above anything the server has - the person
 *   touched it, so the person wins. They may resurrect what they deleted (undo).
 * - An agent's version of the whole file: three-way against the base it was derived from - what the agent changed
 *   applies unless the person changed the same element since that base (then the person's stays, and it is reported
 *   lost); what the agent removed is deleted; what the person added since is kept. Without a trusted base (two-way),
 *   changed elements apply and nothing is inferred deleted.
 */
import type { DrawElement } from '../../shared/draw-protocol.ts'
import { sameContent, wholeElement } from './file.ts'
import { randomBytes } from 'node:crypto'
import { validElementId } from '../../shared/anchor.ts'

export interface Op { id: string; el: DrawElement | null; v: number }
export interface Lost { id: string; by: string; rev: number }

const nonce = () => Math.floor(Math.random() * 2 ** 31)

/** Rename ids and all references together, before maps or ops are keyed by them. */
export function remapElementIds<T extends Record<string, unknown>>(elements: T[], occupied: Iterable<string> = [], duplicates = false): T[] {
  const used = new Set([...occupied, ...elements.flatMap((e) => typeof e.id === 'string' ? [e.id] : [])])
  const taken = new Set(occupied), remap = new Map<string, string>()
  const renamed = elements.map((e) => {
    let id = e.id
    if (!validElementId(id) || (duplicates && taken.has(id))) {
      let fresh: string
      do { fresh = `mv-${randomBytes(12).toString('hex')}` } while (used.has(fresh))
      used.add(fresh)
      if (typeof id === 'string') remap.set(id, fresh)
      id = fresh
    }
    taken.add(id as string)
    return { ...e, id }
  })
  const to = (id: unknown) => typeof id === 'string' ? remap.get(id) ?? id : id
  return renamed.map((e) => {
    const next: Record<string, unknown> = { ...e }
    for (const k of ['containerId', 'frameId']) if (k in next) next[k] = to(next[k])
    if (Array.isArray(next.boundElements)) next.boundElements = next.boundElements.map((b) => ({ ...b, id: to(b.id) }))
    for (const k of ['startBinding', 'endBinding']) {
      const b = next[k] as { elementId?: unknown } | null | undefined
      if (b && typeof b === 'object') next[k] = { ...b, elementId: to(b.elementId) }
    }
    return next as T
  })
}

/** The person's save: their elements win. `cur` = live elements now, `tomb` = deleted ids -> version. */
export function ownerOps(cur: Map<string, DrawElement>, tomb: Map<string, number>, upserts: DrawElement[], deletes: { id: string; version: number }[], now: number): Op[] {
  const ops: Op[] = []
  for (const raw of upserts) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue
    const was = cur.get(raw.id)
    const floor = Math.max(was?.version ?? 0, tomb.get(raw.id) ?? 0)
    const version = Math.max(Number(raw.version) || 1, floor + 1)
    const el: DrawElement = { ...raw, isDeleted: false, version, versionNonce: version === raw.version ? raw.versionNonce : nonce(), customData: { ...(raw.customData ?? {}), mv: { by: 'owner', at: now } } }
    ops.push({ id: raw.id, el, v: version })
  }
  for (const d of deletes) {
    const was = cur.get(d.id)
    if (!was) continue
    ops.push({ id: d.id, el: null, v: Math.max(Number(d.version) || 0, was.version + 1) })
  }
  return ops
}

/**
 * An agent's file, three-way. `base` = the state the agent's file was derived from (null = no trusted base: two-way);
 * `theirs` = the file; `cur` = now; `ownerSince` = ids the person changed after the base (with the rev); `tomb` = deleted.
 */
export function agentOps(base: Map<string, DrawElement> | null, theirs: Map<string, DrawElement>, cur: Map<string, DrawElement>, tomb: Map<string, number>, ownerSince: Map<string, number>, by: string, now: number, deletedSince: Map<string, { by: string; rev: number }> = new Map()): { ops: Op[]; lost: Lost[] } {
  theirs = new Map(remapElementIds([...theirs.values()], [...cur.keys(), ...tomb.keys()]).map((e) => [e.id, e]))
  const ops: Op[] = []
  const lost: Lost[] = []
  const bump = (id: string) => Math.max(cur.get(id)?.version ?? 0, tomb.get(id) ?? 0, base?.get(id)?.version ?? 0) + 1
  const ids = new Set<string>([...theirs.keys(), ...(base ? base.keys() : [])])
  for (const id of ids) {
    const b = base?.get(id), t = theirs.get(id), c = cur.get(id)
    if (base) {
      if (sameContent(t, b)) continue                       // the agent did not change it
    } else {
      if (!t) continue                                      // two-way: an absence says nothing
      if (sameContent(t, c)) continue
    }
    if (ownerSince.has(id)) { lost.push({ id, by: 'owner', rev: ownerSince.get(id)! }); continue }   // the person wins
    if (!t) {                                               // the agent removed it
      if (c) ops.push({ id, el: null, v: bump(id) })
      continue
    }
    // a stale resurrection: deleted and not alive at its base - or deleted by anyone after the base it was read at
    if (!c && tomb.has(id)) {
      const del = deletedSince.get(id)
      if (del) { lost.push({ id, by: del.by, rev: del.rev }); continue }
      if (!b) continue
    }
    const v = bump(id)
    const el = wholeElement({ ...t, version: v, versionNonce: nonce() }, by, now)
    el.version = v
    ops.push({ id, el, v })
  }
  return { ops, lost }
}

/** Repair references an agent's change may have broken (spec 38 decision 11): bound text, containers, arrow bindings
 *  and frame membership pointing at elements that no longer exist. Returns the elements it had to change. */
export function repairRefs(all: Map<string, DrawElement>, touched: Iterable<string>, now: number): DrawElement[] {
  const out = new Map<string, DrawElement>()
  const alive = (id: unknown) => typeof id === 'string' && all.has(id)
  const fix = (e: DrawElement, patch: Record<string, unknown>) => {
    const next = { ...(out.get(e.id) ?? e), ...patch, version: (out.get(e.id) ?? e).version + 1, versionNonce: nonce(), updated: now } as DrawElement
    out.set(e.id, next)
    all.set(e.id, next)
  }
  const scope = new Set(touched)
  for (const e of [...all.values()]) {
    if (Array.isArray(e.boundElements) && (e.boundElements as { id: string }[]).some((b) => !alive(b.id))) fix(e, { boundElements: (e.boundElements as { id: string }[]).filter((b) => alive(b.id)) })
    if (e.containerId && !alive(e.containerId)) fix(e, { containerId: null })
    if (e.frameId && !alive(e.frameId)) fix(e, { frameId: null })
    for (const k of ['startBinding', 'endBinding']) {
      const bnd = e[k] as { elementId?: string } | null | undefined
      if (bnd && !alive(bnd.elementId)) fix(e, { [k]: null })
    }
    // an element an arrow binds to must list that arrow (Excalidraw moves bound arrows with it from that list)
    if ((e.type === 'arrow' || e.type === 'line') && (scope.has(e.id) || ['startBinding', 'endBinding'].some((k) => scope.has((all.get(e.id)![k] as { elementId?: string } | null)?.elementId ?? '')))) {
      for (const k of ['startBinding', 'endBinding']) {
        const tid = (all.get(e.id)![k] as { elementId?: string } | null)?.elementId
        const t = tid ? all.get(tid) : undefined
        if (!t) continue
        const list = (t.boundElements as { id: string; type: string }[] | null) ?? []
        if (!list.some((b) => b.id === e.id)) fix(t, { boundElements: [...list, { id: e.id, type: 'arrow' }] })
      }
    }
    // a container must list the text that names it, and the arrows bound to it
    if (scope.has(e.id) || [...scope].some((id) => all.get(id)?.containerId === e.id)) {
      const listed = new Set(((e.boundElements as { id: string }[] | null) ?? []).map((b) => b.id))
      const missing = [...all.values()].filter((o) => o.containerId === e.id && !listed.has(o.id)).map((o) => ({ id: o.id, type: 'text' }))
      if (missing.length) fix(e, { boundElements: [...((all.get(e.id)!.boundElements as unknown[] | null) ?? []), ...missing] })
    }
  }
  return [...out.values()]
}

/** Move elements by (dx, dy), carrying their bound text and the bound ends of arrows (spec 38: `marver draw move`). */
export function moveOps(all: Map<string, DrawElement>, ids: string[], dx: number, dy: number, by: string, now: number): Op[] {
  const moving = new Set(ids.filter((id) => all.has(id)))
  for (const id of [...moving]) for (const o of all.values()) if (o.containerId === id) moving.add(o.id)
  const ops: Op[] = []
  const put = (e: DrawElement, patch: Record<string, unknown>) => {
    const v = e.version + 1
    ops.push({ id: e.id, v, el: { ...e, ...patch, version: v, versionNonce: nonce(), updated: now, customData: { ...(e.customData ?? {}), mv: { by, at: now } } } as DrawElement })
  }
  for (const id of moving) { const e = all.get(id)!; put(e, { x: Number(e.x) + dx, y: Number(e.y) + dy }) }
  for (const e of all.values()) {
    if (moving.has(e.id) || (e.type !== 'arrow' && e.type !== 'line') || !Array.isArray(e.points)) continue
    const s = (e.startBinding as { elementId?: string } | null)?.elementId, t = (e.endBinding as { elementId?: string } | null)?.elementId
    const sm = !!s && moving.has(s), tm = !!t && moving.has(t)
    if (!sm && !tm) continue
    if (sm && tm) { put(e, { x: Number(e.x) + dx, y: Number(e.y) + dy }); continue }
    const pts = (e.points as number[][]).map((p) => [p[0], p[1]])
    // the box the points span (Excalidraw keeps width/height equal to it)
    const span = (ps: number[][]) => ({ width: Math.max(...ps.map((p) => p[0])) - Math.min(...ps.map((p) => p[0])), height: Math.max(...ps.map((p) => p[1])) - Math.min(...ps.map((p) => p[1])) })
    if (sm) {   // the start moves: the arrow's origin moves, every other point stays where it is
      for (let i = 1; i < pts.length; i++) { pts[i][0] -= dx; pts[i][1] -= dy }
      put(e, { x: Number(e.x) + dx, y: Number(e.y) + dy, points: pts, ...span(pts) })
    } else {
      const last = pts.length - 1
      pts[last][0] += dx; pts[last][1] += dy
      put(e, { points: pts, ...span(pts) })
    }
  }
  return ops
}
