/**
 * In-place updates, what this document saw and no more (spec 30 #15). Vite's client imports `<acceptedPath>?t=<timestamp>`
 * only in a document whose module map holds the module, so a Resource Timing entry for that URL says this document
 * fetched the update; a document that did not writes nothing. Updates only the frame host's registry accepts are left
 * out: it accepts them without applying them (registry.ts), as main.tsx's `sh:hmr` filter does.
 *
 * What it cannot say, it does not: a fetch does not prove the update applied (Vite catches a failed import and still
 * reaches `afterUpdate`), and the next commit need not be the refresh's (Fast Refresh is debounced, an unrelated update
 * can commit first). So `applied` is never true: `'unknown'`, or `false` when Vite's own failure message for that path
 * reached this document's console during the update.
 *
 * Runs only with a hot module at the full level (main.tsx). An observer, not the timeline's buffer: a frame's modules can
 * fill the 250 entries Resource Timing keeps, and an observer still receives what the buffer refuses.
 */
import { RELOAD_BOUNDS } from '../../shared/perf-records.ts'
import type { InplaceMsg } from './messages.ts'

interface Update { type?: string; path?: string; acceptedPath?: string; timestamp?: number }
/** The fields only this module knows; main.tsx adds the frame and the document. */
export type InplaceReport = Omit<InplaceMsg, 'id' | 'boot'>

let waiters: ((at: number) => void)[] = []
/** The frame root committed (the Profiler in main.tsx). */
export function rootCommitted(): void {
  if (!waiters.length) return
  const at = performance.now()
  for (const w of waiters.splice(0)) w(at)
}
/** The next commit's time, or undefined past the wait. */
function nextCommit(ms: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const w = (at: number) => { clearTimeout(t); resolve(at) }
    const t = setTimeout(() => { waiters = waiters.filter((x) => x !== w); resolve(undefined) }, ms)
    waiters.push(w)
  })
}

const isRegistry = (u: Update) => (u.acceptedPath ?? u.path ?? '').includes('/frame-host/registry')
const pathOf = (u: Update) => (u.acceptedPath ?? u.path ?? '').split('?')[0]
/** The URL Vite's client imports (client.mjs `importUpdatedModule`): this update's path, this update's timestamp. */
function fetchedBy(u: Update, entries: readonly PerformanceEntry[]): boolean {
  return entries.some((e) => {
    try {
      const url = new URL(e.name)
      return url.pathname.endsWith(pathOf(u)) && url.searchParams.get('t') === String(u.timestamp)
    } catch { return false }
  })
}

/** Vite's messages run one at a time (its client queues them), so one update round is open at most. */
export function watchInplace(hot: { on(event: string, cb: (p: any) => void): void }, post: (m: InplaceReport) => void): void {
  let round: { at: number; updates: Update[]; seen: PerformanceEntry[]; observer: PerformanceObserver; failed: Set<string>; close: () => void } | null = null

  hot.on('vite:beforeUpdate', (p: { updates?: Update[] }) => {
    try {
      // a round `afterUpdate` never came for (an accept callback threw): nothing of it stays on
      round?.close()
      round = null
      const updates = (p.updates ?? []).filter((u) => u.type === 'js-update' && !isRegistry(u) && typeof u.timestamp === 'number')
      if (!updates.length) return
      const seen: PerformanceEntry[] = []
      const observer = new PerformanceObserver((list) => { seen.push(...list.getEntries()) })
      observer.observe({ type: 'resource' })
      const failed = new Set<string>()
      const original = console.error
      // only while an update is on its way, and the original always runs: Vite's own words for a failed import
      // (client.mjs `warnFailedUpdate`: `[vite] Failed to reload <acceptedPath>. …`)
      const watching = function (this: unknown, ...a: unknown[]) {
        original.apply(this, a)
        for (const x of a) if (typeof x === 'string' && x.startsWith('Failed to reload ')) failed.add(x.slice('Failed to reload '.length).split('. ')[0])
      }
      console.error = watching
      const close = () => {
        observer.disconnect()
        if (console.error === watching) console.error = original   // a frame's own replacement meanwhile stays
      }
      round = { at: performance.now(), updates, seen, observer, failed, close }
    } catch { /* the recorder never stands in the way */ }
  })

  hot.on('vite:afterUpdate', () => {
    const r = round
    round = null
    if (!r) return
    try {
      const after = performance.now()
      const entries = [...r.seen, ...r.observer.takeRecords()]
      r.close()
      for (const u of r.updates) {
        if (!fetchedBy(u, entries)) continue
        const applied = r.failed.has(u.acceptedPath ?? u.path ?? '') ? false as const : 'unknown' as const
        void nextCommit(RELOAD_BOUNDS.commitWaitMs).then((at) => post({
          type: 'sh:inplace', hmrTs: u.timestamp!, applyMs: Math.round(after - r.at), applied,
          ...(at !== undefined ? { nextObservedCommitMs: Math.round(at - after) } : {}),
        }))
      }
    } catch { /* the same */ }
  })
}
