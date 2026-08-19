/**
 * In-memory frame-activity presence (SPEC-live-jam §10). NEVER on disk (session/presence state).
 * The daemon marks a frame `working` while an agent edits it; the dev server broadcasts the set
 * over the existing rail (sh:jam-activity), so the canvas glows within the first second - no poll.
 *
 * Entries carry a lease: a daemon that dies mid-job cannot leave a frame glowing forever - the
 * periodic sweep expires stale entries and re-broadcasts.
 */
export interface Activity {
  mark(frame: string): void
  clear(frame: string): void
  active(): string[]
  sweep(): void
  onChange(cb: (frames: string[]) => void): void
}

export function createActivity(ttlMs = 90_000): Activity {
  const m = new Map<string, number>()   // frame id -> expiry (ms epoch)
  let cb: (frames: string[]) => void = () => {}
  const keys = () => [...m.keys()]
  return {
    mark(frame) { if (!frame) return; m.set(frame, Date.now() + ttlMs); cb(keys()) },
    clear(frame) { if (m.delete(frame)) cb(keys()) },
    active: keys,
    sweep() {
      const now = Date.now()
      let changed = false
      for (const [k, until] of m) if (until <= now) { m.delete(k); changed = true }
      if (changed) cb(keys())
    },
    onChange(fn) { cb = fn },
  }
}
