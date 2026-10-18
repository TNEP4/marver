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
  mark(frame: string, ttlMs?: number, src?: WorkSource): void
  clear(frame: string, src?: WorkSource): void
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
  const m = new Map<string, number>()   // "src|frame" -> expiry (ms epoch)
  const cbs: ((frames: string[]) => void)[] = []
  const frames = () => [...new Set([...m.keys()].map((k) => k.slice(k.indexOf('|') + 1)))]
  const emit = () => { const f = frames(); for (const cb of cbs) cb(f) }
  return {
    mark(frame, ttl, src = 'cli') { if (!frame) return; m.set(`${src}|${frame}`, Date.now() + (ttl ?? ttlMs)); emit() },
    clear(frame, src = 'cli') { if (m.delete(`${src}|${frame}`)) emit() },
    clearAll(src = 'cli') {
      let changed = false
      for (const k of [...m.keys()]) if (k.startsWith(`${src}|`)) { m.delete(k); changed = true }
      if (changed) emit()
    },
    active: frames,
    has(frame, src) { const until = m.get(`${src}|${frame}`); return until !== undefined && until > Date.now() },
    sweep() {
      const now = Date.now()
      let changed = false
      for (const [k, until] of m) if (until <= now) { m.delete(k); changed = true }
      if (changed) emit()
    },
    leases(src) {
      const now = Date.now()
      return [...m].filter(([k, until]) => k.startsWith(`${src}|`) && until > now).map(([k, until]) => [k.slice(src.length + 1), until] as [string, number])
    },
    restore(frame, until, src) { if (frame && until > Date.now()) { m.set(`${src}|${frame}`, until); emit() } },
    onChange(fn) {
      cbs.push(fn)
      return () => { const i = cbs.indexOf(fn); if (i !== -1) cbs.splice(i, 1) }
    },
  }
}
