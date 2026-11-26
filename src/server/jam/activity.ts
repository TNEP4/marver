/**
 * In-memory frame-activity presence. The glow never touches disk; the CLI's holds are also
 * reservations (0.26), so reserve.ts writes those - frame and expiry, nothing else - to survive a
 * dev-server restart.
 * Two writers share one canvas glow but hold SEPARATE leases: the jam daemon marks frames while
 * its agent edits them (heartbeat refreshes the short lease), and the `marver work` CLI marks
 * frames the CHAT-driven agent is building (longer per-mark lease - a terminal agent will not
 * heartbeat between tool calls). Leases are keyed (source, frame) so neither writer can clear
 * the other's work - `work done --all` must never extinguish a running jam job. The broadcast
 * is the UNION of frames across sources.
 *
 * Entries carry a lease: a writer that dies mid-job cannot leave a frame glowing forever - the
 * periodic sweep expires stale entries and re-broadcasts.
 */
export type WorkSource = 'jam' | 'cli'

export interface Activity {
  /** Mark a frame working for a source. `ttlMs` overrides the default lease (caller clamps). */
  mark(frame: string, ttlMs?: number, src?: WorkSource, ids?: readonly string[], key?: string): void
  addIds(frame: string, ids: readonly string[], src: WorkSource): void
  drawings(): Record<string, { ids: string[]; lease: number }>
  clear(frame: string, src?: WorkSource, key?: string): void
  clearAll(src?: WorkSource): void
  active(): string[]
  /** Is `frame` marked by `src` right now (an unexpired lease)? */
  has(frame: string, src: WorkSource): boolean
  sweep(): void
  /** A source's unexpired leases, as [frame, expiry] - what reserve.ts persists. */
  leases(src: WorkSource): [string, number][]
  /** Mark with an absolute expiry (restoring a persisted hold). */
  restore(frame: string, until: number, src: WorkSource): void
  /** Returns an unsubscribe - a closing server must stop receiving broadcasts. */
  onChange(cb: (frames: string[]) => void): () => void
}

export function createActivity(ttlMs = 90_000): Activity {
  const m = new Map<string, { frame: string; src: WorkSource; until: number; ids: Set<string> }>()
  const live = () => [...m.values()].filter((v) => v.until > Date.now())
  const frames = () => [...new Set(live().map((v) => v.frame))]
  const cbs: ((frames: string[]) => void)[] = []
  // Change callbacks retain unswept entries; readers of current work use the live leases.
  const emit = () => { const f = [...new Set([...m.values()].map((v) => v.frame))]; for (const cb of cbs) cb(f) }
  return {
    mark(frame, ttl, src = 'cli', ids = [], key = '') {
      if (!frame) return
      const k = JSON.stringify([src, frame, key]), old = m.get(k)
      m.set(k, { frame, src, until: Date.now() + (ttl ?? ttlMs), ids: new Set([...(old && old.until > Date.now() ? old.ids : []), ...ids]) }); emit()
    },
    addIds(frame, ids, src) {
      let changed = false
      for (const v of live()) if (v.frame === frame && v.src === src) for (const id of ids) if (!v.ids.has(id)) { v.ids.add(id); changed = true }
      if (changed) emit()
    },
    drawings() {
      const out: Record<string, { ids: string[]; lease: number }> = Object.create(null)
      for (const v of live()) if (v.ids.size) {
        const before = out[v.frame]
        out[v.frame] = { ids: [...new Set([...(before?.ids ?? []), ...v.ids])].sort(), lease: Math.max(before?.lease ?? 0, v.until) }
      }
      return out
    },
    clear(frame, src = 'cli', key) {
      let changed = false
      for (const [k, v] of m) if (v.frame === frame && v.src === src && (key === undefined || k === JSON.stringify([src, frame, key]))) { m.delete(k); changed = true }
      if (changed) emit()
    },
    clearAll(src = 'cli') {
      let changed = false
      for (const [k, v] of m) if (v.src === src) { m.delete(k); changed = true }
      if (changed) emit()
    },
    active: frames,
    has(frame, src) { return live().some((v) => v.frame === frame && v.src === src) },
    sweep() {
      let changed = false
      for (const [k, v] of m) if (v.until <= Date.now()) { m.delete(k); changed = true }
      if (changed) emit()
    },
    leases(src) {
      const out = new Map<string, number>()
      for (const v of live()) if (v.src === src) out.set(v.frame, Math.max(out.get(v.frame) ?? 0, v.until))
      return [...out]
    },
    restore(frame, until, src) { if (frame && until > Date.now()) { m.set(JSON.stringify([src, frame, '']), { frame, src, until, ids: new Set() }); emit() } },
    onChange(fn) {
      cbs.push(fn)
      return () => { const i = cbs.indexOf(fn); if (i !== -1) cbs.splice(i, 1) }
    },
  }
}
