/** Process-local bridge between drawing revisions, Jam runs and chat holds. Run handles live only in the log. */
import type { LogEntry } from './service.ts'
import { workActivity } from '../work.ts'

export interface DrawingRun { handle: string; frames: readonly string[]; since: number; lease: number }
interface Watch { read(): DrawingRun | undefined; changed(frame: string, entry: LogEntry): void }
export function createDrawingWork(now: () => number = Date.now) {
  const watches = new Set<Watch>()
  const live = new Map<Watch, DrawingRun>()
  let history: DrawingRun[] = []
  let flush: (() => Promise<void>) | undefined
  // Retain finished holds briefly: an atomic file write may reach the watcher after a claim
  // changes. Attribute at the write's time, never to whichever run happens to remain then.
  const refresh = () => {
    const at = now()
    for (const w of watches) {
      const next = w.read(), old = live.get(w)
      const same = old && next && old.handle === next.handle && old.frames.join('\n') === next.frames.join('\n')
      if (same) { old.lease = next.lease; continue }
      if (old) { history.push({ ...old, lease: Math.min(old.lease, at) }); live.delete(w) }
      if (next) live.set(w, { ...next, since: old ? Math.max(next.since, at) : next.since, frames: [...next.frames] })
    }
    history = history.filter((r) => r.lease > at - 30 * 60_000)
  }
  return {
    refresh,
    service(fn: () => Promise<void>) { flush = fn; return () => { if (flush === fn) flush = undefined } },
    async flush() { await flush?.() },
    watch(w: Watch) {
      watches.add(w); refresh()
      return () => { refresh(); const r = live.get(w); if (r) history.push({ ...r, lease: Math.min(r.lease, now()) }); live.delete(w); watches.delete(w) }
    },
    claim(handle: string, at = now()): boolean { refresh(); return [...live.values()].some((r) => r.handle === handle && r.since <= at && r.lease > at) },
    attribute(frame: string, at: number, explicit?: string): string | undefined {
      if (explicit) return explicit
      refresh()
      const eligible = [...history, ...live.values()].filter((r) => r.since <= at && r.lease > at && r.frames.includes(frame)).map((r) => r.handle)
      return new Set(eligible).size === 1 ? eligible[0] : undefined
    },
    committed(frame: string, entry: LogEntry) {
      if (entry.by === 'owner') return
      if (workActivity.has(frame, 'cli')) workActivity.addIds(frame, entry.ops.map((o) => o.id), 'cli')
      for (const w of watches) if (entry.run && w.read()?.handle === entry.run) w.changed(frame, entry)
    },
  }
}
const roots = new Map<string, ReturnType<typeof createDrawingWork>>()
export function drawingWork(root: string) {
  let work = roots.get(root)
  if (!work) roots.set(root, (work = createDrawingWork()))
  return work
}
